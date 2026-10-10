"""Run generated decks through LAMMPS in WSL (Ubuntu, ~/lmpval: pip wheel + Intel MPI runtime).

Used for (a) `validate`: full-size build + `run 0` -> exact atom counts and syntax check;
(b) `preview_run`: reduced-scale A then B for a real (small) MD result to visualise.
"""
import os
import re
import subprocess
import copy
from .deck import deck_a, deck_b, write_run_folder, POT_DIR
from .geometry import Model
from .schema import validate as schema_validate

WSL = ["wsl", "-d", "Ubuntu", "--", "bash", "-lc"]


def wsl_path(p):
    p = os.path.abspath(p).replace("\\", "/")
    return re.sub(r"^([A-Za-z]):", lambda m: "/mnt/" + m.group(1).lower(), p)


def available():
    try:
        r = subprocess.run(WSL + ["test -x $HOME/lmpval/bin/lmp && echo OK"], capture_output=True, text=True, timeout=60)
        return "OK" in r.stdout
    except Exception:
        return False


def run_lammps(workdir, infile, logname, np=1, timeout=3600):
    """Run `lmp -in infile` in workdir (Windows path) via WSL. Returns (returncode, stdout_tail, log_text)."""
    # wsl.exe re-parses the command line through the default shell, so a script file is the robust way to pass it
    script = os.path.join(workdir, "lmp_run.sh")
    with open(script, "w", newline="\n") as f:
        f.write("#!/bin/bash\n"
                f"cd \"{wsl_path(workdir)}\" || exit 1\n"
                "export PATH=\"$HOME/lmpval/bin:$PATH\"\n"
                "export LD_LIBRARY_PATH=\"$HOME/lmpval/lib:$LD_LIBRARY_PATH\"\n"
                f"mpirun -np {np} \"$HOME/lmpval/bin/lmp\" -in {infile} -log {logname} -nocite 2>&1 | tail -n 60\n"
                "exit ${PIPESTATUS[0]}\n")
    r = subprocess.run(["wsl", "-d", "Ubuntu", "--", "bash", wsl_path(script)], capture_output=True, text=True, timeout=timeout)
    log = ""
    lp = os.path.join(workdir, logname)
    if os.path.exists(lp):
        log = open(lp, errors="replace").read()
    return r.returncode, r.stdout, log


def parse_log(log):
    """Extract group counts, errors, thermo table(s) from a LAMMPS log."""
    groups = {g: int(n) for n, g in re.findall(r"^(\d+) atoms in group (\S+)", log, flags=re.M)}
    errors = re.findall(r"^ERROR.*$", log, flags=re.M)
    warns = re.findall(r"^WARNING.*$", log, flags=re.M)
    natoms = re.search(r"Loop time of \S+ on \d+ procs for \d+ steps with (\d+) atoms", log)
    created = re.findall(r"Created (\d+) atoms", log)
    perf = re.search(r"Performance: .*?(\S+) katom-step/s", log)
    return dict(groups=groups, errors=errors, warnings=warns, natoms=int(natoms.group(1)) if natoms else None,
                created=[int(c) for c in created], katom_steps_per_s=float(perf.group(1)) if perf else None)


def validate_in_lammps(exp, workdir, np=4, timeout=1800):
    """Full-size build of deck A with run 0. Returns parse_log dict + 'ok'."""
    errs = schema_validate(exp)
    if errs:
        return dict(ok=False, errors=errs, groups={}, warnings=[])
    os.makedirs(workdir, exist_ok=True)
    m = Model(exp)
    a, files, _ = deck_a(exp, m, dry_run=True)
    open(os.path.join(workdir, "A_dry.in"), "w", newline="\n").write(a)
    for f in files:
        import shutil
        shutil.copy(os.path.join(POT_DIR, f), workdir)
    rc, out, log = run_lammps(workdir, "A_dry.in", "A_dry.log", np=np, timeout=timeout)
    res = parse_log(log or out)
    res["ok"] = rc == 0 and not res["errors"] and "A dry run done" in (log + out)
    res["stdout"] = out
    res["expected"] = m.counts()
    return res


def scaled_experiment(exp, scale=0.25, cut_length_nm=None, equil_ps=None):
    """Reduced-scale copy: workpiece/tool block sizes and layers scaled; depth, speed, radius, angles kept."""
    e = copy.deepcopy(exp)
    w, t = e.workpiece, e.tool
    for n in ("length_nm", "height_nm"):
        setattr(w, n, max(getattr(w, n) * scale, 3 * (w.fixed_nm + w.thermo_nm) + 2 * e.process.depth_nm + 2))
    w.width_nm = min(w.width_nm, 2 * w.a0 / 10 * 2)   # 2 cells wide
    if t.shape == "wedge":
        t.length_nm = max(t.length_nm * scale, 2 * t.edge_radius_nm + 2 * (t.fixed_nm + t.thermo_nm) + 1)
        t.height_nm = max(t.height_nm * scale, 2 * t.edge_radius_nm + 2 * (t.fixed_nm + t.thermo_nm) + 1)
    e.process.cut_length_nm = cut_length_nm or min(e.process.cut_length_nm, w.length_nm * 0.4)
    e.thermo.equil_ps = equil_ps or min(e.thermo.equil_ps, 2.0)
    e.output.dump_every_equil = max(e.output.dump_every_equil, 10 ** 9)
    e.output.restart_every_equil = 10 ** 9
    e.output.restart_every_cut = 10 ** 9
    e.name = exp.name + "_preview"
    return e


def preview_run(exp, workdir, np=4, timeout=7200, progress=None):
    """Write a reduced-scale run folder and execute A then B. Returns dict(ok, log_a, log_b, dir, exp)."""
    e = exp
    info = write_run_folder(e, workdir)
    if progress:
        progress("running A (equilibration)...")
    rc_a, out_a, log_a = run_lammps(workdir, "A.in", "A.log", np=np, timeout=timeout)
    ok_a = rc_a == 0 and "A done" in (log_a + out_a)
    if not ok_a:
        return dict(ok=False, stage="A", stdout=out_a, log=log_a, dir=workdir, exp=e, info=info)
    if progress:
        progress("running B (cutting)...")
    rc_b, out_b, log_b = run_lammps(workdir, "B.in", "B.log", np=np, timeout=timeout)
    ok_b = rc_b == 0 and "B done" in (log_b + out_b)
    return dict(ok=ok_b, stage="B", stdout=out_b, log=log_b, log_a=log_a, dir=workdir, exp=e, info=info)

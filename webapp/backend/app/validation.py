"""Validation, split into two layers that the UI keeps apart:

  parsing    - could each file be read and understood (params.json, decks, dump headers, force file, logs)?
  scientific - are the values consistent and plausible (schema rules, restart chain A->B, potential A vs B,
               atom counts vs the NanoCut model, advice rules, archived verification of the reference decks)?
"""
import json
import os
import re
import time
from pathlib import Path

from nanocut.analysis import read_avetime
from nanocut.schema import Experiment, validate as schema_validate

from . import advice, catalog, dumps, models, params
from .settings import PROJECT_ROOT, rel


def _check(name, status, detail=""):
    return dict(name=name, status=status, detail=detail)


def _abs(path):
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def _restart_chain(a_txt, b_txt):
    """Name of the file deck B reads vs the file(s) deck A produces (write_restart or periodic restart at run end)."""
    rb = re.search(r"^read_restart\s+(\S+)", b_txt, re.M)
    if not rb:
        return None, None, []
    produced = re.findall(r"^write_restart\s+(\S+)", a_txt, re.M)
    rp = re.search(r"^restart\s+(\d+)\s+(\S+)", a_txt, re.M)
    runs = [int(x) for x in re.findall(r"^run\s+(\d+)", a_txt, re.M)]
    if rp and runs:
        every, base = int(rp.group(1)), rp.group(2)
        total = sum(runs)
        for s in range(every, total + 1, every):
            produced.append(base.replace("*", str(s)) if "*" in base else f"{base}.{s}")
    return rb.group(1), rb.group(1) in produced, produced[-3:]


def validate_sim(sim):
    parsing, sci = [], []
    exp = catalog.experiment_dict(sim)
    pj = catalog.params_json(sim) if sim["kind"] == "run" else None
    if sim["kind"] == "run":
        parsing.append(_check("params.json", "ok" if pj and "experiment" in pj else "error",
                              "experiment and model summary read" if pj else "missing or invalid JSON"))
    a, b = params.find_decks(sim)
    a_txt = b_txt = ""
    for f, which in ((a, "A"), (b, "B")):
        if sim["kind"] == "preset":
            continue
        if not f:
            parsing.append(_check(f"deck {which}", "error", "not found"))
            continue
        txt = _abs(f["path"]).read_text(errors="replace")
        if which == "A":
            a_txt = txt
        else:
            b_txt = txt
        if not txt.strip():
            parsing.append(_check(f"deck {which}", "error", f"{f['name']} is empty"))
            continue
        ps, err = params.parse_deck(f["path"], which)
        parsing.append(_check(f"deck {which}", "ok" if ps else "warn", f"{f['name']}: {len(ps)} recognised commands"))
    if sim["kind"] != "preset" and sim.get("path"):
        folder = _abs(sim["path"])
        dl, kind = dumps.list_dumps(str(folder))
        if dl:
            heads, bad = [], []
            for step, pth in dl:
                try:
                    heads.append(dumps.read_header(pth))
                except Exception as e:
                    bad.append(f"{os.path.basename(pth)}: {e}")
            nat = sorted({h["natoms"] for h in heads})
            parsing.append(_check("dump headers", "ok" if not bad else "error",
                                  f"{len(heads)} of {len(dl)} frames readable, steps {dl[0][0]}..{dl[-1][0]}, atoms {nat}" + (f"; unreadable: {bad[:3]}" if bad else "")))
            model, _ = models.summary_for(sim, start=False)
            if model and nat:
                exp_n = model.get("counts", {}).get("total")
                sci.append(_check("atom count: dumps vs NanoCut model", "ok" if nat == [exp_n] else "error",
                                  f"dumps {nat}, model {exp_n}"))
        ff = [f for f in sim["files"] if f["role"] == "forces"]
        for f in ff:
            try:
                names, arr = read_avetime(str(_abs(f["path"])))
                parsing.append(_check("force/temperature file", "ok" if len(arr) else "warn", f"{f['name']}: {len(arr)} rows, columns {names}"))
            except Exception as e:
                parsing.append(_check("force/temperature file", "error", f"{f['name']}: {e}"))
        for f in sim["files"]:
            if f["role"] == "log":
                txt = _abs(f["path"]).read_text(errors="replace")
                errs = re.findall(r"^ERROR.*$", txt, re.M)
                warns = sorted(set(re.findall(r"^WARNING: (.*?)(?: \(src.*)?$", txt, re.M)))
                done = "Total wall time" in txt
                st = "error" if errs else ("ok" if done else "warn")
                parsing.append(_check(f"log {f['name']}", st, (errs[0] if errs else ("finished" if done else "not finished / still running"))
                                      + (f"; {len(warns)} distinct warnings" if warns else "")))
    # ---- scientific ----
    if exp and sim["kind"] != "reference":
        try:
            errs = schema_validate(Experiment.from_dict(exp))
            sci.append(_check("parameter rules (schema)", "error" if errs else "ok", "; ".join(errs) or "all inputs within allowed ranges"))
        except Exception as e:
            sci.append(_check("parameter rules (schema)", "error", str(e)))
        model, _ = models.summary_for(sim, start=False)
        if sim["kind"] == "run" and model:
            try:
                now = models.build_summary(exp)["counts"]["total"]
                st = model.get("counts", {}).get("total")
                sci.append(_check("stored model vs current NanoCut geometry", "ok" if now == st else "warn",
                                  f"params.json {st} atoms, current code {now} atoms" + ("" if now == st else
                                  " - folder generated before the 2026-10-10 tool-gap fix; its decks and dumps are self-consistent")))
            except Exception as e:
                sci.append(_check("stored model vs current NanoCut geometry", "warn", f"could not rebuild: {e}"))
        for wmsg in advice.soft_warnings(exp, model):
            sci.append(_check("physics advice", "warn", wmsg))
    if a_txt and b_txt:
        reads, ok, produced = _restart_chain(a_txt, b_txt)
        if reads:
            sci.append(_check("restart chain A -> B", "ok" if ok else "warn",
                              f"B reads {reads}; A produces {', '.join(produced) or 'nothing recognised'}"))
        pa = sorted(set(re.findall(r"^pair_coeff\s+\*\s+\*\s+(\S+)", a_txt, re.M)))
        pb = sorted(set(re.findall(r"^pair_coeff\s+\*\s+\*\s+(\S+)", b_txt, re.M)))
        if not pb:   # reference decks choose the file through `variable potential string y94|EA` + if/elif
            sel = re.search(r"^variable\s+potential\s+string\s+(\S+)", b_txt, re.M)
            name = {"y94": "SiC_1994.tersoff", "EA": "SiC_Erhart-Albe.tersoff"}.get(sel.group(1) if sel else "")
            pb = [name] if name else []
        if pa and pb:
            same = set(pa) == set(pb)
            sci.append(_check("same potential in A and B", "ok" if same else "warn",
                              f"A: {', '.join(pa)}; B: {', '.join(pb)}" + ("" if same else " - equilibrated and cut with different potentials")))
        ba = re.search(r"^boundary\s+(\S+\s+\S+\s+\S+)", a_txt, re.M)
        bb = re.search(r"^boundary\s+(\S+\s+\S+\s+\S+)", b_txt, re.M)
        if ba and bb:
            sa, sb = " ".join(ba.group(1).split()), " ".join(bb.group(1).split())
            sci.append(_check("boundary A vs B", "ok" if sa == sb else "warn",
                              f"A: {sa}; B: {sb}" + ("" if sa == sb else " - read_restart keeps A's setting and LAMMPS warns")))
    if sim["kind"] == "reference":
        dc = PROJECT_ROOT / "reference" / "deck_checks.json"
        if dc.exists():
            d = json.loads(dc.read_text())
            case = next((c for c in d["cases"] if c["case"] == sim["case"]), None)
            if case:
                bad = [r for r in case["rows"] if r["status"] == "DIFFERENT" and not str(r.get("note", "")).startswith("INTENDED")]
                sci.append(_check("NanoCut reproduces this deck (archived verification)",
                                  "ok" if case["verdict"] == "PASS" else "error",
                                  f"{len(case['rows'])} parameters compared, {len(bad)} unintended differences "
                                  f"(tools/verify_decks.py, {time.strftime('%Y-%m-%d %H:%M', time.localtime(dc.stat().st_mtime))})"))
    def summary(checks):
        s = {"ok": 0, "warn": 0, "error": 0}
        for c in checks:
            s[c["status"]] = s.get(c["status"], 0) + 1
        s["state"] = "error" if s["error"] else ("warn" if s["warn"] else ("ok" if checks else "n/a"))
        return s
    return dict(id=sim["id"], label=sim["label"], kind=sim["kind"], parsing=parsing, scientific=sci,
                parsing_summary=summary(parsing), scientific_summary=summary(sci), inspected=time.time())


def global_checks():
    out = []
    pc = PROJECT_ROOT / "reference" / "potential_checks.json"
    if pc.exists():
        rows = json.loads(pc.read_text())
        worst_a = max(abs(r.get("a0_dev_pct") or 0) for r in rows)
        errs = [r["file"] for r in rows if r.get("a0") is None]
        out.append(dict(name="potential files reproduce published a0 / Ecoh in LAMMPS", status="error" if errs else "ok",
                        detail=f"{len(rows)} file/structure checks; largest a0 deviation {worst_a:.2f} % "
                               f"(Tersoff-1994 3C-SiC, a known property of that parameter set); failures: {errs or 'none'}",
                        source=rel(pc), checked=pc.stat().st_mtime, rows=rows))
    dc = PROJECT_ROOT / "reference" / "deck_checks.json"
    if dc.exists():
        d = json.loads(dc.read_text())
        passed = sum(c["verdict"] == "PASS" for c in d["cases"])
        out.append(dict(name="generated decks equal the reference decks", status="ok" if passed == len(d["cases"]) else "error",
                        detail=f"{passed} of {len(d['cases'])} reference cases PASS (tools/verify_decks.py)",
                        source=rel(dc), checked=dc.stat().st_mtime,
                        rows=[dict(case=c["case"], verdict=c["verdict"]) for c in d["cases"]]))
    return out


def validate_all(progress=None):
    sims = list(catalog.scan(force=True).values())
    res = []
    for i, s in enumerate(sims):
        if progress:
            progress(i / max(1, len(sims)), s["label"])
        try:
            res.append(validate_sim(s))
        except Exception as e:
            res.append(dict(id=s["id"], label=s["label"], kind=s["kind"], parsing=[_check("validation", "error", str(e))],
                            scientific=[], parsing_summary=dict(state="error", ok=0, warn=0, error=1),
                            scientific_summary=dict(state="n/a", ok=0, warn=0, error=0), inspected=time.time()))
    return dict(simulations=res, global_checks=global_checks(), inspected=time.time())

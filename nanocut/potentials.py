"""Potential catalogue and pair_style/pair_coeff block builder.

Facts (file names, element tokens, citations) come from the headers of the files bundled
with the LAMMPS 22Jul2025 wheel and from reference/potentials_catalogue.md. Syntax rules:
LAMMPS manual 30Sep2026 (pair_style hybrid, tersoff, sw, eam, morse, zbl, lj/cut).
"""
from .materials import Z

MANYBODY = {"tersoff", "tersoff/mod", "tersoff/zbl", "sw", "vashishta", "eam/alloy", "eam/fs", "edip/multi"}

# tokens: element -> token string used in the file's pair_coeff mapping
POTENTIALS = {
    "SiC_1994": dict(file="SiC_1994.tersoff", style="tersoff", tokens={"Si": "Si", "C": "C"},
                     label="Tersoff Si-C (1994, smooth cutoffs)", dt_fs=0.5,
                     citation="J. Tersoff, Phys. Rev. B 49, 16349 (1994); file DATE 2011-05-03",
                     note="Potential used for the cutting stage (B) of the reference decks (variable potential = y94)."),
    "SiC_Erhart-Albe": dict(file="SiC_Erhart-Albe.tersoff", style="tersoff", tokens={"Si": "Si", "C": "C"},
                            label="Erhart-Albe ABOP Si-C (2005)", dt_fs=0.5,
                            citation="P. Erhart, K. Albe, Phys. Rev. B 71, 035211 (2005); file DATE 2009-05-05",
                            note="Potential used for the equilibration stage (A) of the reference decks. Better elastic constants/melting for SiC."),
    "SiC_1989": dict(file="SiC_1989.tersoff", style="tersoff", tokens={"Si": "Si", "C": "C"},
                     label="Tersoff Si-C (1989)", dt_fs=0.5, citation="J. Tersoff, Phys. Rev. B 39, 5566 (1989)", note=""),
    "SiC_1990": dict(file="SiC_1990.tersoff", style="tersoff", tokens={"Si": "Si", "C": "C"},
                     label="Tersoff Si-C (1990, abrupt C cutoff)", dt_fs=0.5,
                     citation="J. Tersoff, Phys. Rev. B 41, 3248 (1990)", note="Abrupt cutoff (D=0) for carbon."),
    "SiC.tersoff": dict(file="SiC.tersoff", style="tersoff", tokens={"Si": "Si", "C": "C"},
                        label="Tersoff Si-C (1989 + errata) — standard for Si/SiC/diamond machining", dt_fs=0.5,
                        citation="J. Tersoff, Phys. Rev. B 39, 5566 (1989), errata PRB 41, 3248 (1990)", note=""),
    "SiC.tersoff.zbl": dict(file="SiC.tersoff.zbl", style="tersoff/zbl", tokens={"Si": "Si", "C": "C"},
                            label="Tersoff Si-C + ZBL core (Devanathan 1998)", dt_fs=0.5,
                            citation="R. Devanathan et al., J. Nucl. Mater. 253, 47 (1998)",
                            note="Use when atoms are pushed below ~1 Å (very high speed)."),
    "SiC.vashishta": dict(file="SiC.vashishta", style="vashishta", tokens={"Si": "Si", "C": "C"},
                          label="Vashishta Si-C (2007) — rigid tool only", dt_fs=0.5, rigid_tool_only=True,
                          citation="P. Vashishta et al., J. Appl. Phys. 101, 103515 (2007)",
                          note="No pure-C three-body terms: cannot describe a deformable diamond tool."),
    "Si.sw": dict(file="Si.sw", style="sw", tokens={"Si": "Si"}, label="Stillinger-Weber Si (1985)", dt_fs=1.0,
                  citation="F. H. Stillinger, T. A. Weber, Phys. Rev. B 31, 5262 (1985)", note="Si-Si only; tool needs a cross term."),
    "Si.tersoff": dict(file="Si.tersoff", style="tersoff", tokens={"Si": "Si"}, label="Tersoff Si (1988)", dt_fs=0.5,
                       citation="J. Tersoff, Phys. Rev. B 38, 9902 (1988)", note="Si-Si only; tool needs a cross term."),
    "Si.tersoff.mod": dict(file="Si.tersoff.mod", style="tersoff/mod", tokens={"Si": "Si"},
                           label="Kumagai modified Tersoff Si (2007)", dt_fs=0.5,
                           citation="T. Kumagai et al., Comput. Mater. Sci. 39, 457 (2007)", note="Si-Si only; tool needs a cross term."),
    "SiCGe.tersoff": dict(file="SiCGe.tersoff", style="tersoff", tokens={"Si": "Si(D)", "C": "C", "Ge": "Ge"},
                          label="Tersoff Si/C/Ge (1989) — no Ge-C entries", dt_fs=0.5, excluded_pairs={("Ge", "C")},
                          citation="J. Tersoff, Phys. Rev. B 39, 5566 (1989)",
                          note="Ge-C triplets are absent in the file: Ge + diamond tool needs a Morse cross term (hybrid)."),
    "Cu_mishin1.eam.alloy": dict(file="Cu_mishin1.eam.alloy", style="eam/alloy", tokens={"Cu": "Cu"},
                                 label="EAM Cu (Mishin 2001)", dt_fs=1.0,
                                 citation="Y. Mishin et al., Phys. Rev. B 63, 224106 (2001)", note=""),
    "Cu_zhou.eam.alloy": dict(file="Cu_zhou.eam.alloy", style="eam/alloy", tokens={"Cu": "Cu"},
                              label="EAM Cu (Zhou 2004)", dt_fs=1.0, citation="X. W. Zhou et al., Phys. Rev. B 69, 144113 (2004)", note=""),
    "Cu_u3.eam": dict(file="Cu_u3.eam", style="eam", tokens={"Cu": "Cu"}, label="EAM Cu (Foiles u3)", dt_fs=1.0,
                      citation="S. M. Foiles, M. I. Baskes, M. S. Daw, Phys. Rev. B 33, 7983 (1986)", note="funcfl file (per-type pair_coeff)."),
    "Al_zhou.eam.alloy": dict(file="Al_zhou.eam.alloy", style="eam/alloy", tokens={"Al": "Al"}, label="EAM Al (Zhou 2004)",
                              dt_fs=1.0, citation="X. W. Zhou et al., Phys. Rev. B 69, 144113 (2004)", note=""),
    "Al_mm.eam.fs": dict(file="Al_mm.eam.fs", style="eam/fs", tokens={"Al": "Al"}, label="EAM/FS Al (Mendelev)",
                         dt_fs=1.0, citation="M. I. Mendelev et al., Philos. Mag. 88, 1723 (2008) [file CITATION: Unknown]", note=""),
    "Ni_u3.eam": dict(file="Ni_u3.eam", style="eam", tokens={"Ni": "Ni"}, label="EAM Ni (Foiles u3)", dt_fs=1.0,
                      citation="S. M. Foiles, M. I. Baskes, M. S. Daw, Phys. Rev. B 33, 7983 (1986)", note="funcfl file."),
    "Au_u3.eam": dict(file="Au_u3.eam", style="eam", tokens={"Au": "Au"}, label="EAM Au (Foiles u3)", dt_fs=1.0,
                      citation="S. M. Foiles, M. I. Baskes, M. S. Daw, Phys. Rev. B 33, 7983 (1986)", note="funcfl file."),
    "Ag_u3.eam": dict(file="Ag_u3.eam", style="eam", tokens={"Ag": "Ag"}, label="EAM Ag (Foiles u3)", dt_fs=1.0,
                      citation="S. M. Foiles, M. I. Baskes, M. S. Daw, Phys. Rev. B 33, 7983 (1986)", note="funcfl file."),
    "Fe_mm.eam.fs": dict(file="Fe_mm.eam.fs", style="eam/fs", tokens={"Fe": "Fe"}, label="EAM/FS Fe (Mendelev 2003)",
                         dt_fs=1.0, citation="M. I. Mendelev et al., Philos. Mag. 83, 3977 (2003)", note=""),
    "W_zhou.eam.alloy": dict(file="W_zhou.eam.alloy", style="eam/alloy", tokens={"W": "W"}, label="EAM W (Zhou 2004)",
                             dt_fs=1.0, citation="X. W. Zhou et al., Phys. Rev. B 69, 144113 (2004)", note=""),
}

# C-C potential used for a deformable diamond tool when the workpiece potential does not cover carbon
TOOL_CC = dict(file="SiC.tersoff", style="tersoff", token="C",
               citation="J. Tersoff, Phys. Rev. B 39, 5566 (1989) — carbon entry")

# Morse cross terms: (D0 eV, alpha 1/Å, r0 Å, rc Å, source, verified)
MORSE = {
    ("Cu", "C"): (0.087, 5.14, 2.05, 6.5, "Lin & Huang (2004); used in e.g. Micromachines 16(5) 570 (2025), Nanoscale Res. Lett. 8, 211 (2013)", True),
    ("Si", "C"): (0.435, 4.6487, 1.9475, 6.5, "e.g. RSC Adv. 7, 30929 (2017); Micromachines 17(7) 872 (2026) — rigid diamond tool", True),
    ("Ge", "C"): (0.125778, 2.58219, 2.2324, 6.5, "M. Lai et al., Nanoscale Res. Lett. 8, 13 (2013), Table 1", True),
    ("Ni", "C"): (0.100, 2.2, 2.4, 6.5, "Coatings 12(5) 647 (2022) — PARTIALLY VERIFIED (abstract only)", False),
}


def potentials_for(elements):
    """Catalogue keys whose files cover every element of the workpiece (tool cross terms handled separately)."""
    out = []
    for k, p in POTENTIALS.items():
        if all(e in p["tokens"] for e in elements):
            out.append(k)
    return out


def pair_block(tool_elem, wp_elems, pot_key, deformable, cross):
    """Return (lines, files, warnings).

    types: 1 = tool element, 2.. = workpiece elements in order.
    cross: dict(style='auto'|'morse'|'zbl'|'lj', D, alpha, r0, rc, eps, sigma)
    """
    p = POTENTIALS[pot_key]
    elems = [tool_elem] + list(wp_elems)
    warnings = []
    files = [p["file"]]
    excluded = p.get("excluded_pairs", set())

    def covered(a, b):
        return a in p["tokens"] and b in p["tokens"] and (a, b) not in excluded and (b, a) not in excluded

    tool_pairs_ok = all(covered(tool_elem, e) for e in wp_elems)
    tool_self_ok = covered(tool_elem, tool_elem) and not p.get("rigid_tool_only", False)
    if p.get("rigid_tool_only") and deformable:
        warnings.append(f"{pot_key} cannot describe a deformable diamond tool (no pure-C three-body terms); set the tool to rigid.")

    if tool_pairs_ok and (tool_self_ok or not deformable) and p["style"] in MANYBODY and tool_elem in p["tokens"]:
        toks = " ".join(p["tokens"][e] for e in elems)
        lines = [f"pair_style      {p['style']}",
                 f"pair_coeff      * * {p['file']} {toks}    # type order: " + " ".join(f"{i+1}={e}" for i, e in enumerate(elems))]
        return lines, files, warnings

    # ---- hybrid: workpiece sub-style + (tool C-C if deformable) + pairwise cross term ----
    wp_style = p["style"]
    subs = [wp_style]
    if deformable:
        subs.append(TOOL_CC["style"])
        files.append(TOOL_CC["file"])
    cstyle = cross.get("style", "auto")
    if cstyle == "auto":
        cstyle = "morse" if all(_morse_key(tool_elem, e) for e in wp_elems) else "zbl"
    if cstyle == "morse":
        rc = cross.get("rc") or 6.5
        subs.append(f"morse {rc}")
    elif cstyle == "lj":
        rc = cross.get("rc") or 6.5
        subs.append(f"lj/cut {rc}")
    else:
        subs.append("zbl 3.0 4.0")
        warnings.append("Tool-workpiece cross interaction is a ZBL repulsive wall (no adhesion, parameter-free fallback). "
                        "State this in any report.")

    # number duplicate sub-styles (manual: 'pair_style hybrid tersoff tersoff' -> 'tersoff 1', 'tersoff 2')
    names = [s.split()[0] for s in subs]
    def tag(i):
        n = names[i]
        if names.count(n) > 1:
            return f"{n} {names[:i+1].count(n)}"
        return n

    lines = ["pair_style      hybrid " + " ".join(subs)]
    nt = len(elems)
    # workpiece
    if wp_style in MANYBODY:
        toks = ["NULL"] + [p["tokens"][e] for e in wp_elems]
        lines.append(f"pair_coeff      * * {tag(0)} {p['file']} {' '.join(toks)}")
    elif wp_style == "eam":  # funcfl: per type
        for j, e in enumerate(wp_elems, start=2):
            lines.append(f"pair_coeff      {j} {j} eam {p['file']}")
        if len(wp_elems) > 1:
            warnings.append("funcfl EAM with >1 workpiece element mixes cross terms DYNAMO-style; prefer an eam/alloy file.")
    else:
        raise ValueError(f"unsupported workpiece pair style {wp_style}")
    # tool self
    if deformable:
        toks = [TOOL_CC["token"]] + ["NULL"] * (nt - 1)
        lines.append(f"pair_coeff      * * {tag(1)} {TOOL_CC['file']} {' '.join(toks)}")
    else:
        lines.append("pair_coeff      1 1 none    # rigid tool: no tool-tool interaction needed")
    # cross
    for j, e in enumerate(wp_elems, start=2):
        if cstyle == "morse":
            mk = _morse_key(tool_elem, e)
            if cross.get("D") is not None:
                D, a, r0 = cross["D"], cross["alpha"], cross["r0"]
                src = "user-supplied"
            elif mk:
                D, a, r0, _, src, ok = MORSE[mk]
                if not ok:
                    warnings.append(f"Morse {tool_elem}-{e} parameters are only partially verified ({src}).")
            else:
                raise ValueError(f"No Morse parameters known for {tool_elem}-{e}; enter D0, alpha, r0 or choose ZBL.")
            lines.append(f"pair_coeff      1 {j} morse {D} {a} {r0}    # {tool_elem}-{e} Morse: {src}")
        elif cstyle == "lj":
            lines.append(f"pair_coeff      1 {j} lj/cut {cross['eps']} {cross['sigma']}    # {tool_elem}-{e} LJ (user-supplied)")
        else:
            lines.append(f"pair_coeff      1 {j} zbl {Z[tool_elem]} {Z[e]}    # {tool_elem}-{e} ZBL repulsion")
    # workpiece self pairs under hybrid when wp style is pairwise-eam: cross wp-wp handled by the file; nothing more.
    return lines, files, warnings


def _morse_key(a, b):
    if (a, b) in MORSE:
        return (a, b)
    if (b, a) in MORSE:
        return (b, a)
    return None

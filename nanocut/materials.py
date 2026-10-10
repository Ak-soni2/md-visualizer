"""Material database (lattice constants in Å, masses in g/mol, cutoffs in Å).

Structures are built the way the reference decks build them: cubic conventional cell,
`lattice <style> a0 orient ... origin ...` + `create_atoms`. Zinc-blende (3C-SiC) is two
fcc sublattices, the second shifted by (1/4,1/4,1/4) (reference A.txt lines 84-91).
"""

# fractional basis of the cubic conventional cell for each LAMMPS lattice style
BASIS = {
    "sc": [(0, 0, 0)],
    "bcc": [(0, 0, 0), (0.5, 0.5, 0.5)],
    "fcc": [(0, 0, 0), (0.5, 0.5, 0), (0.5, 0, 0.5), (0, 0.5, 0.5)],
}
BASIS["diamond"] = BASIS["fcc"] + [(x + 0.25, y + 0.25, z + 0.25) for x, y, z in BASIS["fcc"]]

MASS = {  # g/mol (IUPAC conventional)
    "C": 12.011, "Si": 28.0855, "Ge": 72.63, "Cu": 63.546, "Al": 26.9815, "Ni": 58.6934,
    "Au": 196.9666, "Ag": 107.8682, "Fe": 55.845, "W": 183.84, "Ti": 47.867,
}
Z = {"C": 6, "Si": 14, "Ge": 32, "Cu": 29, "Al": 13, "Ni": 28, "Au": 79, "Ag": 47, "Fe": 26, "W": 74, "Ti": 22}

# structure: "zincblende" = sublattice 0 (elements[0]) on fcc at origin, sublattice 1 (elements[1]) on fcc at +1/4
MATERIALS = {
    "3C-SiC": dict(label="3C-SiC (cubic silicon carbide, zinc-blende)", structure="zincblende", a0=4.3667,
                   elements=["Si", "C"], default_potential="SiC_1994", coord_cutoff=2.6, dt_fs=0.5,
                   a0_note="4.3667 Å as in the reference decks (experiment 4.3596 Å)",
                   E_GPa=448.0, H_GPa=28.0, Kc=3.3, brittle=True),
    "Si": dict(label="Silicon (diamond cubic)", structure="diamond", a0=5.431, elements=["Si"],
               default_potential="SiC.tersoff", coord_cutoff=2.6, dt_fs=0.5, a0_note="5.431 Å (experiment)",
               E_GPa=130.0, H_GPa=12.0, Kc=0.9, brittle=True),
    "Ge": dict(label="Germanium (diamond cubic)", structure="diamond", a0=5.658, elements=["Ge"],
               default_potential="SiCGe.tersoff", coord_cutoff=2.9, dt_fs=0.5, a0_note="5.658 Å (experiment)",
               E_GPa=103.0, H_GPa=9.0, Kc=0.6, brittle=True),
    "diamond": dict(label="Diamond (carbon)", structure="diamond", a0=3.567, elements=["C"],
                    default_potential="SiC.tersoff", coord_cutoff=1.9, dt_fs=0.3, a0_note="3.567 Å (experiment)",
                    brittle=True),
    "Cu": dict(label="Copper (fcc)", structure="fcc", a0=3.615, elements=["Cu"], default_potential="Cu_mishin1.eam.alloy",
               coord_cutoff=3.1, dt_fs=1.0, a0_note="3.615 Å (experiment)", brittle=False),
    "Al": dict(label="Aluminium (fcc)", structure="fcc", a0=4.05, elements=["Al"], default_potential="Al_zhou.eam.alloy",
               coord_cutoff=3.5, dt_fs=1.0, a0_note="4.05 Å (experiment)", brittle=False),
    "Ni": dict(label="Nickel (fcc)", structure="fcc", a0=3.52, elements=["Ni"], default_potential="Ni_u3.eam",
               coord_cutoff=3.0, dt_fs=1.0, a0_note="3.52 Å (experiment)", brittle=False),
    "Au": dict(label="Gold (fcc)", structure="fcc", a0=4.078, elements=["Au"], default_potential="Au_u3.eam",
               coord_cutoff=3.5, dt_fs=1.0, a0_note="4.078 Å (experiment)", brittle=False),
    "Ag": dict(label="Silver (fcc)", structure="fcc", a0=4.09, elements=["Ag"], default_potential="Ag_u3.eam",
               coord_cutoff=3.5, dt_fs=1.0, a0_note="4.09 Å (experiment)", brittle=False),
    "Fe": dict(label="Iron (bcc)", structure="bcc", a0=2.8665, elements=["Fe"], default_potential="Fe_mm.eam.fs",
               coord_cutoff=3.0, dt_fs=1.0, a0_note="2.8665 Å (experiment)", brittle=False),
    "W": dict(label="Tungsten (bcc)", structure="bcc", a0=3.165, elements=["W"], default_potential="W_zhou.eam.alloy",
              coord_cutoff=3.3, dt_fs=1.0, a0_note="3.165 Å (experiment)", brittle=False),
}

TOOL_MATERIALS = {
    "diamond": dict(label="Diamond (C)", structure="diamond", a0=3.571, elements=["C"],
                    a0_note="3.571 Å as in the reference decks (experiment 3.567 Å)"),
}


def sublattices(structure):
    """Return list of (lattice_style, origin_shift_frac, element_index) to issue as lattice/create_atoms pairs."""
    if structure == "zincblende":
        return [("fcc", (0.0, 0.0, 0.0), 0), ("fcc", (0.25, 0.25, 0.25), 1)]
    return [(structure, (0.0, 0.0, 0.0), 0)]


def cna_lattice(structure):
    return {"fcc": "fcc", "bcc": "bcc"}.get(structure)

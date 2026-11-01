"""Input generation: pw.x presets and multi-step workflows (bands, DOS/PDOS, phonons,
charge density, convergence scans, equation of state).

A workflow returns a JobSpec dict:
  {"kind": ..., "name": ..., "steps": [StepSpec...], "workflow": {...metadata for analysis...}}
StepSpec: {"label", "program", "input_name", "input", "output_name", "cwd", "np", "args", "save_xml"}
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import structure as ST
from .namelist import Card, QEInput, parse, render
from .schema import schema_order

PRESETS = {
    # k-spacing in 1/Angstrom (2*pi included), conv_thr per atom (Ry), degauss (Ry)
    "fast": {
        "kspacing": 0.30,
        "conv_thr_per_atom": 1e-8,
        "degauss": 0.02,
        "etot_conv_thr_per_atom": 1e-4,
        "forc_conv_thr": 1e-3,
    },
    "standard": {
        "kspacing": 0.20,
        "conv_thr_per_atom": 2e-10,
        "degauss": 0.01,
        "etot_conv_thr_per_atom": 1e-5,
        "forc_conv_thr": 5e-4,
    },
    "precise": {
        "kspacing": 0.15,
        "conv_thr_per_atom": 1e-11,
        "degauss": 0.01,
        "etot_conv_thr_per_atom": 1e-6,
        "forc_conv_thr": 1e-4,
    },
}


class GenerateError(ValueError):
    pass


def _r(qi: QEInput) -> str:
    return render(qi, sort_keys=True, schema_order=schema_order(qi.program))


def _pseudo_map(s: ST.Structure, pseudo_map: dict[str, str] | None) -> dict[str, str]:
    from .. import pseudos as PS

    out: dict[str, str] = {}
    pseudo_map = pseudo_map or {}
    for label in ST.species_order(s):
        sp = s["species"][label]
        el = sp["element"]
        fn = sp.get("pseudo") or pseudo_map.get(label) or pseudo_map.get(el)
        if not fn:
            pick = PS.pick_for_element(el)
            fn = pick["filename"] if pick else f"{el}.upf"
        out[label] = fn
    return out


def nelec_estimate(s: ST.Structure, pmap: dict[str, str]) -> float | None:
    from .. import pseudos as PS

    zv = PS.valence(pmap)
    total = 0.0
    for site in s["sites"]:
        z = zv.get(site["species"])
        if z is None or math.isnan(z):
            return None
        total += z
    return total


def pw_input(s: ST.Structure, calculation: str = "scf", opts: dict[str, Any] | None = None) -> QEInput:
    """Build a pw.x input for a structure with sensible, documented defaults."""
    from .. import pseudos as PS

    o = dict(opts or {})
    preset = PRESETS.get(o.get("preset", "standard"), PRESETS["standard"])
    s = ST.normalize(s)
    nat = len(s["sites"])
    if nat == 0:
        raise GenerateError("structure has no atoms")
    pmap = _pseudo_map(s, o.get("pseudos"))
    for lab, fn in pmap.items():
        s["species"][lab]["pseudo"] = fn
    qi = QEInput(program="pw")
    prefix = o.get("prefix") or "pwscf"
    qi.set("CONTROL", "calculation", calculation)
    qi.set("CONTROL", "prefix", prefix)
    qi.set("CONTROL", "outdir", "./tmp/")
    qi.set("CONTROL", "pseudo_dir", "./pseudo/")
    if calculation in ("scf", "relax", "vc-relax"):
        qi.set("CONTROL", "tprnfor", True)
        qi.set("CONTROL", "tstress", True)
    if calculation in ("relax", "vc-relax", "md", "vc-md"):
        qi.set("CONTROL", "etot_conv_thr", float(f"{preset['etot_conv_thr_per_atom'] * nat:.1e}"))
        qi.set("CONTROL", "forc_conv_thr", float(o.get("forc_conv_thr") or preset["forc_conv_thr"]))
        if o.get("nstep"):
            qi.set("CONTROL", "nstep", int(o["nstep"]))
    if o.get("verbosity"):
        qi.set("CONTROL", "verbosity", o["verbosity"])

    # cutoffs
    cut = PS.suggested_cutoffs(list(set(pmap.values())))
    ecutwfc = o.get("ecutwfc") or cut["ecutwfc"] or 45.0
    dual = o.get("dual") or cut["dual"]
    ecutrho = o.get("ecutrho") or max(cut.get("ecutrho") or 0.0, float(ecutwfc) * float(dual))
    ST.apply_to_pw_input(qi, s)
    qi.set("SYSTEM", "ecutwfc", float(ecutwfc))
    qi.set("SYSTEM", "ecutrho", float(ecutrho))

    # occupations
    occ = o.get("occupations", "smearing")
    if occ == "smearing":
        qi.set("SYSTEM", "occupations", "smearing")
        qi.set("SYSTEM", "smearing", o.get("smearing") or "cold")
        qi.set("SYSTEM", "degauss", float(o.get("degauss") or preset["degauss"]))
    elif occ in ("fixed", "tetrahedra", "tetrahedra_opt", "tetrahedra_lin"):
        qi.set("SYSTEM", "occupations", occ)
    # spin
    spin = o.get("spin", "auto")
    mags = {lab: s["species"][lab].get("magnetization") for lab in ST.species_order(s)}
    has_mag = any(m not in (None, 0, 0.0) for m in mags.values())
    if spin == "collinear" or (spin == "auto" and has_mag):
        qi.set("SYSTEM", "nspin", 2)
        if not has_mag:
            for i, _lab in enumerate(ST.species_order(s)):
                qi.set("SYSTEM", f"starting_magnetization({i + 1})", 0.5)
    elif spin == "noncollinear":
        qi.set("SYSTEM", "noncolin", True)
        if o.get("spinorbit"):
            qi.set("SYSTEM", "lspinorb", True)
        if not has_mag:
            for i, _lab in enumerate(ST.species_order(s)):
                qi.set("SYSTEM", f"starting_magnetization({i + 1})", 0.5)
    elif spin == "none":
        for k in list(qi.nl("SYSTEM")):
            if k.lower().startswith("starting_magnetization("):
                del qi.nl("SYSTEM")[k]
    for key in ("nbnd", "tot_charge", "input_dft", "vdw_corr", "assume_isolated", "tot_magnetization", "nosym"):
        if o.get(key) not in (None, ""):
            qi.set("SYSTEM", key, o[key])
    if not all(s["pbc"]) and o.get("assume_isolated") is None and s["pbc"][:2] == [True, True]:
        qi.set("SYSTEM", "assume_isolated", "2D")

    # Hubbard (QE >= 7.1 card)
    hub = o.get("hubbard") or {}
    hub_lines = []
    for lab in ST.species_order(s):
        u = hub.get(lab, s["species"][lab].get("hubbard_u"))
        if u not in (None, 0, 0.0):
            orb = (o.get("hubbard_orbitals") or {}).get(lab) or _default_hubbard_orbital(s["species"][lab]["element"])
            hub_lines.append(f"U {lab}-{orb} {float(u)}")
    if hub_lines:
        qi.set_card(Card("HUBBARD", o.get("hubbard_projector", "ortho-atomic"), hub_lines))

    # electrons
    ct = float(o.get("conv_thr") or float(f"{preset['conv_thr_per_atom'] * nat:.1e}"))
    qi.set("ELECTRONS", "conv_thr", ct)
    if o.get("mixing_beta"):
        qi.set("ELECTRONS", "mixing_beta", float(o["mixing_beta"]))
    if calculation in ("relax", "vc-relax"):
        qi.set("IONS", "ion_dynamics", "bfgs")
    if calculation == "vc-relax":
        qi.set("CELL", "cell_dynamics", "bfgs")
        if o.get("press") is not None:
            qi.set("CELL", "press", float(o["press"]))
        qi.set("CELL", "press_conv_thr", float(o.get("press_conv_thr", 0.5)))
        if o.get("cell_dofree"):
            qi.set("CELL", "cell_dofree", o["cell_dofree"])

    # k-points
    if o.get("kmesh"):
        mesh = [int(x) for x in o["kmesh"]]
    else:
        mesh = ST.kmesh(s, float(o.get("kspacing") or preset["kspacing"]))
    shift = [int(x) for x in (o.get("kshift") or [0, 0, 0])]
    if mesh == [1, 1, 1] and o.get("gamma_trick"):
        qi.set_card(Card("K_POINTS", "gamma", []))
    else:
        qi.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, mesh + shift))]))
    _sort_cards(qi)
    return qi


def _default_hubbard_orbital(el: str) -> str:
    d3 = {"Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn"}
    d4 = {"Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd"}
    d5 = {"Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg"}
    f4 = {"La", "Ce", "Pr", "Nd", "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu"}
    f5 = {"Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm"}
    if el in d3:
        return "3d"
    if el in d4:
        return "4d"
    if el in d5:
        return "5d"
    if el in f4:
        return "4f"
    if el in f5:
        return "5f"
    if el in ("O", "N", "C", "F"):
        return "2p"
    if el in ("S", "Cl", "P", "Si"):
        return "3p"
    return "3d"


def _sort_cards(qi: QEInput) -> None:
    order = {
        n: i
        for i, n in enumerate(
            [
                "ATOMIC_SPECIES",
                "ATOMIC_POSITIONS",
                "K_POINTS",
                "ADDITIONAL_K_POINTS",
                "CELL_PARAMETERS",
                "CONSTRAINTS",
                "OCCUPATIONS",
                "ATOMIC_VELOCITIES",
                "ATOMIC_FORCES",
                "SOLVENTS",
                "HUBBARD",
                "TOTAL_CHARGE",
            ]
        )
    }
    qi.cards.sort(key=lambda c: order.get(c.name, 99))


def step(
    label: str,
    program: str,
    input_name: str,
    text: str,
    np_: int | None = None,
    cwd: str = ".",
    args: str = "",
    save_xml: str | None = None,
) -> dict[str, Any]:
    stem = input_name.rsplit(".", 1)[0]
    return {
        "label": label,
        "program": program,
        "input_name": input_name,
        "input": text,
        "output_name": f"{stem}.out",
        "cwd": cwd,
        "np": np_,
        "args": args,
        "save_xml": save_xml,
    }


def _pw_meta(qi: QEInput) -> tuple[str, str]:
    return str(qi.get("CONTROL", "prefix", "pwscf")), str(qi.get("CONTROL", "outdir", "./tmp/"))


def _xml_path(qi: QEInput) -> str:
    prefix, outdir = _pw_meta(qi)
    return outdir.rstrip("/") + f"/{prefix}.xml"


def _structure_from(scf: QEInput) -> ST.Structure:
    return ST.from_pw_input(scf)


def _nbnd_for(scf: QEInput, factor: float = 1.3, extra: int = 4) -> int | None:
    s = _structure_from(scf)
    pmap = {}
    sp = scf.card("ATOMIC_SPECIES")
    if sp:
        for ln in sp.lines:
            t = ln.split()
            pmap[t[0]] = t[2]
    ne = nelec_estimate(s, pmap)
    if ne is None:
        return None
    nspin_factor = 2 if scf.get("SYSTEM", "noncolin") else 1
    occ = math.ceil(ne / 2.0) * nspin_factor
    return int(max(occ + extra, math.ceil(occ * factor)))


# ----------------------------------------------------------------------------- workflows
def wf_single(scf_text: str, name: str = "pw") -> dict[str, Any]:
    qi = parse(scf_text, "pw")
    calc = str(qi.get("CONTROL", "calculation", "scf"))
    return {
        "kind": calc,
        "name": name,
        "steps": [step(calc, "pw.x", f"{calc}.in", _r(qi), save_xml=_xml_path(qi))],
        "workflow": {"kind": calc},
    }


def wf_bands(
    scf_text: str, npoints: int = 120, path: str | None = None, nbnd: int | None = None, projwfc: bool = False
) -> dict[str, Any]:
    scf = parse(scf_text, "pw")
    scf.set("CONTROL", "calculation", "scf")
    s = _structure_from(scf)
    kp = ST.kpath(s, npoints, path)
    prefix, outdir = _pw_meta(scf)
    bands = parse(_r(scf), "pw")
    bands.set("CONTROL", "calculation", "bands")
    for k in ("tprnfor", "tstress"):
        bands.set("CONTROL", k, None)
    nb = nbnd or _nbnd_for(scf)
    if nb:
        bands.set("SYSTEM", "nbnd", nb)
    bands.set_card(Card("K_POINTS", "crystal_b", [str(len(kp["lines"]))] + kp["lines"]))
    bx = QEInput(program="bands")
    bx.set("BANDS", "prefix", prefix)
    bx.set("BANDS", "outdir", outdir)
    bx.set("BANDS", "filband", "bands.dat")
    bx.set("BANDS", "lsym", False)
    steps = [
        step("SCF", "pw.x", "scf.in", _r(scf), save_xml=_xml_path(scf)),
        step("Bands (NSCF on path)", "pw.x", "bands.in", _r(bands), save_xml=_xml_path(bands)),
        step("bands.x post-processing", "bands.x", "bandsx.in", _r(bx), np_=1),
    ]
    if projwfc:
        pj = QEInput(program="projwfc")
        pj.set("PROJWFC", "prefix", prefix)
        pj.set("PROJWFC", "outdir", outdir)
        pj.set("PROJWFC", "filpdos", "bands_proj")
        pj.set("PROJWFC", "lsym", False)
        steps.append(step("Projections on path (fat bands)", "projwfc.x", "projwfc_bands.in", _r(pj)))
    return {
        "kind": "bands",
        "name": f"{prefix} bands",
        "steps": steps,
        "workflow": {
            "kind": "bands",
            "kpath": kp,
            "scf_output": "scf.out",
            "bands_output": "bands.out",
            "bands_xml": "bands.xml",
            "scf_xml": "scf.xml",
        },
    }


def wf_dos(
    scf_text: str,
    kmesh_factor: float = 2.0,
    nbnd: int | None = None,
    emin: float | None = None,
    emax: float | None = None,
    delta_e: float = 0.01,
    pdos: bool = True,
    occupations: str = "tetrahedra_opt",
) -> dict[str, Any]:
    scf = parse(scf_text, "pw")
    scf.set("CONTROL", "calculation", "scf")
    prefix, outdir = _pw_meta(scf)
    nscf = parse(_r(scf), "pw")
    nscf.set("CONTROL", "calculation", "nscf")
    for k in ("tprnfor", "tstress"):
        nscf.set("CONTROL", k, None)
    if occupations.startswith("tetrahedra"):
        for k in ("smearing", "degauss"):
            nscf.set("SYSTEM", k, None)
        nscf.set("SYSTEM", "occupations", occupations)
    nb = nbnd or _nbnd_for(scf)
    if nb:
        nscf.set("SYSTEM", "nbnd", nb)
    kc = scf.card("K_POINTS")
    if kc and kc.option == "automatic" and kc.lines:
        v = [int(x) for x in kc.lines[0].split()]
        mesh = [max(1, round(x * kmesh_factor)) for x in v[:3]]
        nscf.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, [*mesh, 0, 0, 0]))]))
    dos = QEInput(program="dos")
    dos.set("DOS", "prefix", prefix)
    dos.set("DOS", "outdir", outdir)
    dos.set("DOS", "fildos", f"{prefix}.dos")
    dos.set("DOS", "DeltaE", float(delta_e))
    if emin is not None:
        dos.set("DOS", "Emin", float(emin))
    if emax is not None:
        dos.set("DOS", "Emax", float(emax))
    if not occupations.startswith("tetrahedra"):
        dos.set("DOS", "degauss", float(scf.get("SYSTEM", "degauss", 0.01) or 0.01))
    steps = [
        step("SCF", "pw.x", "scf.in", _r(scf), save_xml=_xml_path(scf)),
        step("NSCF (dense mesh)", "pw.x", "nscf.in", _r(nscf), save_xml=_xml_path(nscf)),
        step("Total DOS", "dos.x", "dos.in", _r(dos), np_=1),
    ]
    if pdos:
        pj = QEInput(program="projwfc")
        pj.set("PROJWFC", "prefix", prefix)
        pj.set("PROJWFC", "outdir", outdir)
        pj.set("PROJWFC", "filpdos", prefix)
        pj.set("PROJWFC", "DeltaE", float(delta_e))
        if emin is not None:
            pj.set("PROJWFC", "Emin", float(emin))
        if emax is not None:
            pj.set("PROJWFC", "Emax", float(emax))
        if not occupations.startswith("tetrahedra"):
            pj.set("PROJWFC", "degauss", float(scf.get("SYSTEM", "degauss", 0.01) or 0.01))
        steps.append(step("Projected DOS", "projwfc.x", "projwfc.in", _r(pj)))
    return {
        "kind": "dos",
        "name": f"{prefix} DOS",
        "steps": steps,
        "workflow": {
            "kind": "dos",
            "prefix": prefix,
            "dos_file": f"{prefix}.dos",
            "pdos_prefix": prefix,
            "scf_output": "scf.out",
            "nscf_output": "nscf.out",
        },
    }


def wf_phonon(
    scf_text: str,
    nq: list[int] | None = None,
    npoints: int = 100,
    path: str | None = None,
    tr2_ph: float = 1e-14,
    asr: str = "crystal",
    dos_mesh: list[int] | None = None,
    epsil: bool = False,
) -> dict[str, Any]:
    scf = parse(scf_text, "pw")
    scf.set("CONTROL", "calculation", "scf")
    ct = scf.get("ELECTRONS", "conv_thr")
    if not isinstance(ct, (int, float)) or ct > 1e-10:
        scf.set("ELECTRONS", "conv_thr", 1e-12)  # phonons need well converged ground states
    prefix, outdir = _pw_meta(scf)
    s = _structure_from(scf)
    if not nq:
        rec = ST.reciprocal(np.array(s["cell"]))
        nq = [max(2, min(6, round(np.linalg.norm(b) / 0.5))) if p else 1 for b, p in zip(rec, s["pbc"])]
    ph = QEInput(program="ph", preamble=[f"phonons of {prefix}"])
    ph.set("INPUTPH", "prefix", prefix)
    ph.set("INPUTPH", "outdir", outdir)
    ph.set("INPUTPH", "fildyn", f"{prefix}.dyn")
    ph.set("INPUTPH", "tr2_ph", float(tr2_ph))
    ph.set("INPUTPH", "ldisp", True)
    ph.set("INPUTPH", "nq1", int(nq[0]))
    ph.set("INPUTPH", "nq2", int(nq[1]))
    ph.set("INPUTPH", "nq3", int(nq[2]))
    if epsil:
        ph.set("INPUTPH", "epsil", True)
    q2r = QEInput(program="q2r")
    q2r.set("INPUT", "fildyn", f"{prefix}.dyn")
    q2r.set("INPUT", "zasr", asr if asr in ("simple", "crystal", "one-dim", "zero-dim") else "crystal")
    q2r.set("INPUT", "flfrc", f"{prefix}.fc")
    kp = ST.kpath(s, npoints, path)
    md = QEInput(program="matdyn")
    md.set("INPUT", "asr", asr)
    md.set("INPUT", "flfrc", f"{prefix}.fc")
    md.set("INPUT", "flfrq", f"{prefix}.freq")
    md.set("INPUT", "flvec", f"{prefix}.modes")
    md.set("INPUT", "q_in_band_form", True)
    md.set("INPUT", "q_in_cryst_coord", True)
    md.trailing = [str(len(kp["lines"]))] + kp["lines"]
    mdd = QEInput(program="matdyn")
    dm = dos_mesh or [min(24, max(12, 6 * n)) for n in nq]  # interpolation grid; cheap compared with ph.x
    mdd.set("INPUT", "asr", asr)
    mdd.set("INPUT", "flfrc", f"{prefix}.fc")
    mdd.set("INPUT", "dos", True)
    mdd.set("INPUT", "fldos", f"{prefix}.phdos")
    mdd.set("INPUT", "nk1", int(dm[0]))
    mdd.set("INPUT", "nk2", int(dm[1]))
    mdd.set("INPUT", "nk3", int(dm[2]))
    # tetrahedra (matdyn's default, normalised to 3*nat); the analysis falls back to its own Gaussian
    # DOS from the .dos.freq grid if matdyn's result is NaN or mis-normalised (see analysis.py)
    mdd.set("INPUT", "deltaE", 1.0)
    mdd.set("INPUT", "flfrq", f"{prefix}.dos.freq")
    mdd.set("INPUT", "flvec", f"{prefix}.dos.modes")
    steps = [
        step("SCF", "pw.x", "scf.in", _r(scf), save_xml=_xml_path(scf)),
        step("Phonons on q-grid", "ph.x", "ph.in", _r(ph)),
        step("Force constants (q2r)", "q2r.x", "q2r.in", _r(q2r), np_=1),
        step("Dispersion (matdyn)", "matdyn.x", "matdyn.in", _r(md), np_=1),
        step("Phonon DOS (matdyn)", "matdyn.x", "matdyn_dos.in", _r(mdd), np_=1),
    ]
    return {
        "kind": "phonon",
        "name": f"{prefix} phonons",
        "steps": steps,
        "workflow": {
            "kind": "phonon",
            "kpath": kp,
            "freq_file": f"{prefix}.freq",
            "phdos_file": f"{prefix}.phdos",
            "dos_freq_file": f"{prefix}.dos.freq",
            "nq": nq,
            "prefix": prefix,
        },
    }


def wf_density(
    scf_text: str, plot_num: int = 0, output_format: int = 6, extra: dict[str, Any] | None = None
) -> dict[str, Any]:
    scf = parse(scf_text, "pw")
    scf.set("CONTROL", "calculation", "scf")
    prefix, outdir = _pw_meta(scf)
    pp = QEInput(program="pp")
    pp.set("INPUTPP", "prefix", prefix)
    pp.set("INPUTPP", "outdir", outdir)
    pp.set("INPUTPP", "filplot", f"{prefix}.pp")
    pp.set("INPUTPP", "plot_num", int(plot_num))
    for k, v in (extra or {}).items():
        pp.set("INPUTPP", k, v)
    pp.set("PLOT", "iflag", 3)
    pp.set("PLOT", "output_format", int(output_format))
    ext = {6: "cube", 5: "xsf"}.get(int(output_format), "dat")
    pp.set("PLOT", "fileout", f"{prefix}_plot{plot_num}.{ext}")
    pp.set("PLOT", "nfile", 1)
    pp.set("PLOT", "filepp(1)", f"{prefix}.pp")
    pp.set("PLOT", "weight(1)", 1.0)
    return {
        "kind": "density",
        "name": f"{prefix} density",
        "steps": [
            step("SCF", "pw.x", "scf.in", _r(scf), save_xml=_xml_path(scf)),
            step("Post-processing (pp.x)", "pp.x", "pp.in", _r(pp)),
        ],
        "workflow": {"kind": "density", "cube": f"{prefix}_plot{plot_num}.{ext}", "plot_num": plot_num},
    }


def wf_convergence(scf_text: str, parameter: str, values: list[Any], dual: float | None = None) -> dict[str, Any]:
    base = parse(scf_text, "pw")
    base.set("CONTROL", "calculation", "scf")
    base.set("CONTROL", "tprnfor", True)
    base.set("CONTROL", "tstress", True)
    if not values:
        raise GenerateError("no values to scan")
    if dual is None:
        ew, er = base.get("SYSTEM", "ecutwfc"), base.get("SYSTEM", "ecutrho")
        dual = (float(er) / float(ew)) if isinstance(ew, (int, float)) and isinstance(er, (int, float)) else 4.0
    steps, labels = [], []
    for i, value in enumerate(values):
        v = value
        qi = parse(_r(base), "pw")
        if parameter == "ecutwfc":
            qi.set("SYSTEM", "ecutwfc", float(v))
            qi.set("SYSTEM", "ecutrho", float(v) * float(dual))
            lab = f"{float(v):g} Ry"
        elif parameter == "ecutrho":
            qi.set("SYSTEM", "ecutrho", float(v))
            lab = f"{float(v):g} Ry"
        elif parameter == "kpoints":
            mesh = [int(x) for x in (v if isinstance(v, (list, tuple)) else [v, v, v])]
            kc = base.card("K_POINTS")
            shift = [0, 0, 0]
            if kc and kc.option == "automatic" and kc.lines:
                shift = [int(x) for x in kc.lines[0].split()[3:6]] or [0, 0, 0]
            qi.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, mesh + shift))]))
            lab = "x".join(map(str, mesh))
            v = mesh
        elif parameter == "kspacing":
            s = _structure_from(base)
            mesh = ST.kmesh(s, float(v))
            qi.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, [*mesh, 0, 0, 0]))]))
            lab = f"{float(v):g} 1/Å ({'x'.join(map(str, mesh))})"
        elif parameter == "degauss":
            qi.set("SYSTEM", "occupations", "smearing")
            qi.set("SYSTEM", "degauss", float(v))
            if qi.get("SYSTEM", "smearing") is None:
                qi.set("SYSTEM", "smearing", "cold")
            lab = f"{float(v):g} Ry"
        else:
            raise GenerateError(f"unsupported convergence parameter '{parameter}'")
        _sort_cards(qi)
        d = f"c{i + 1:02d}"
        qi.set("CONTROL", "pseudo_dir", "../pseudo/")
        steps.append(step(f"{parameter} = {lab}", "pw.x", "scf.in", _r(qi), cwd=d, save_xml=_xml_path(qi)))
        labels.append({"dir": d, "value": v, "label": lab})
    return {
        "kind": "convergence",
        "name": f"convergence: {parameter}",
        "steps": steps,
        "workflow": {
            "kind": "convergence",
            "parameter": parameter,
            "points": labels,
            "nat": int(base.get("SYSTEM", "nat", 1) or 1),
        },
    }


def wf_eos(scf_text: str, npoints: int = 7, max_strain: float = 0.06, relax_ions: bool = False) -> dict[str, Any]:
    """Uniform volume scan V0*(1+x) for x in [-max_strain, max_strain] (volume strain)."""
    base = parse(scf_text, "pw")
    base.set("CONTROL", "calculation", "relax" if relax_ions else "scf")
    base.set("CONTROL", "tstress", True)
    s0 = _structure_from(base)
    if npoints < 5:
        raise GenerateError("use at least 5 volumes for a Birch-Murnaghan fit")
    v0 = abs(float(np.linalg.det(np.array(s0["cell"]))))
    steps, pts = [], []
    for i, x in enumerate(np.linspace(-max_strain, max_strain, npoints)):
        f = 1.0 + float(x)
        s = ST.transform(s0, "scale_volume", {"factor": f})
        qi = parse(_r(base), "pw")
        ST.apply_to_pw_input(qi, s)
        _sort_cards(qi)
        d = f"v{i + 1:02d}"
        qi.set("CONTROL", "pseudo_dir", "../pseudo/")
        steps.append(step(f"V = {v0 * f:.3f} Å³", "pw.x", "scf.in", _r(qi), cwd=d, save_xml=_xml_path(qi)))
        pts.append({"dir": d, "volume": v0 * f, "factor": f})
    return {
        "kind": "eos",
        "name": "equation of state",
        "steps": steps,
        "workflow": {"kind": "eos", "points": pts, "v0": v0, "nat": len(s0["sites"])},
    }


def post_input(program: str, prefix: str = "pwscf", outdir: str = "./tmp/", **kw: Any) -> str:
    """Templates for stand-alone post-processing inputs."""
    if program == "dos":
        qi = QEInput(program="dos")
        qi.set("DOS", "prefix", prefix)
        qi.set("DOS", "outdir", outdir)
        qi.set("DOS", "fildos", f"{prefix}.dos")
        qi.set("DOS", "DeltaE", 0.01)
    elif program == "projwfc":
        qi = QEInput(program="projwfc")
        qi.set("PROJWFC", "prefix", prefix)
        qi.set("PROJWFC", "outdir", outdir)
        qi.set("PROJWFC", "filpdos", prefix)
        qi.set("PROJWFC", "DeltaE", 0.01)
    elif program == "bands":
        qi = QEInput(program="bands")
        qi.set("BANDS", "prefix", prefix)
        qi.set("BANDS", "outdir", outdir)
        qi.set("BANDS", "filband", "bands.dat")
    elif program == "pp":
        return (
            _r(parse(wf_density(kw["scf_text"])["steps"][1]["input"], "pp"))
            if kw.get("scf_text")
            else _r(
                parse(
                    f"&INPUTPP\n prefix='{prefix}'\n outdir='{outdir}'\n filplot='{prefix}.pp'\n plot_num=0\n/\n"
                    f"&PLOT\n iflag=3\n output_format=6\n fileout='{prefix}_rho.cube'\n nfile=1\n"
                    f" filepp(1)='{prefix}.pp'\n weight(1)=1.0\n/\n",
                    "pp",
                )
            )
        )
    elif program == "ph":
        qi = QEInput(program="ph", preamble=[f"phonons of {prefix}"])
        qi.set("INPUTPH", "prefix", prefix)
        qi.set("INPUTPH", "outdir", outdir)
        qi.set("INPUTPH", "fildyn", f"{prefix}.dyn")
        qi.set("INPUTPH", "tr2_ph", 1e-14)
        qi.set("INPUTPH", "ldisp", True)
        for k in ("nq1", "nq2", "nq3"):
            qi.set("INPUTPH", k, 4)
    elif program == "q2r":
        qi = QEInput(program="q2r")
        qi.set("INPUT", "fildyn", f"{prefix}.dyn")
        qi.set("INPUT", "zasr", "crystal")
        qi.set("INPUT", "flfrc", f"{prefix}.fc")
    elif program == "matdyn":
        qi = QEInput(program="matdyn")
        qi.set("INPUT", "asr", "crystal")
        qi.set("INPUT", "flfrc", f"{prefix}.fc")
        qi.set("INPUT", "dos", True)
        qi.set("INPUT", "fldos", f"{prefix}.phdos")
        for k in ("nk1", "nk2", "nk3"):
            qi.set("INPUT", k, 16)
    else:
        raise GenerateError(f"no template for {program}")
    return _r(qi)

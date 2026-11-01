"""High-level analysis of finished (or running) jobs from their local result cache."""

from __future__ import annotations

import logging
import math
import re
from pathlib import Path
from typing import Any

import numpy as np

from .core.parsers import post as P
from .core.parsers.pw_out import parse_generic_output, parse_pw_output
from .core.parsers.pw_xml import band_gap, parse_pw_xml
from .core.units import EV_PER_A3_TO_GPA, RY_EV

log = logging.getLogger(__name__)

PROGRAM_KEY = {
    "pw.x": "pw",
    "ph.x": "ph",
    "pp.x": "pp",
    "dos.x": "dos",
    "projwfc.x": "projwfc",
    "bands.x": "bands",
    "q2r.x": "q2r",
    "matdyn.x": "matdyn",
    "hp.x": "hp",
    "neb.x": "neb",
}


def _read(p: Path, limit: int | None = None) -> str | None:
    if not p.exists():
        return None
    with open(p, "rb") as fh:
        data = fh.read(limit) if limit else fh.read()
    return data.decode("utf-8", errors="replace")


def _finite(x: Any) -> Any:
    if isinstance(x, float) and not math.isfinite(x):
        return None
    return x


def sanitize(obj: Any) -> Any:
    """Replace NaN/inf by None recursively (JSON-safe)."""
    if isinstance(obj, dict):
        return {k: sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return _finite(float(obj))
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.ndarray):
        return sanitize(obj.tolist())
    return _finite(obj)


def step_summary(d: Path, st: dict[str, Any]) -> dict[str, Any]:
    prog = PROGRAM_KEY.get(st.get("program", ""), st.get("program", ""))
    out_path = d / st.get("cwd", ".") / st["output_name"]
    text = _read(out_path)
    res: dict[str, Any] = {
        "label": st.get("label"),
        "program": st.get("program"),
        "output": str(Path(st.get("cwd", ".")) / st["output_name"]),
        "exists": text is not None,
    }
    if text is None:
        return res
    try:
        if prog == "pw":
            r = parse_pw_output(text)
            r.pop("bands_at_k", None)
            res.update(r)
        else:
            res.update(parse_generic_output(text, prog))
    except Exception as exc:  # parsers must never break the API
        log.exception("parse failed for %s", out_path)
        res["parse_error"] = str(exc)
    return res


def _trajectory(text: str) -> list[dict[str, Any]]:
    import io

    from ase.io import read

    from .core.structure import from_atoms

    try:
        frames = read(io.StringIO(text), format="espresso-out", index=":")
    except Exception:
        return []
    out = []
    for a in frames:
        try:
            s = from_atoms(a)
            e = a.get_potential_energy() if a.calc is not None else None
            f = a.get_forces() if a.calc is not None and "forces" in a.calc.results else None
            out.append(
                {
                    "structure": s,
                    "energy_ev": e,
                    "max_force_ev_a": float(np.max(np.linalg.norm(f, axis=1))) if f is not None and len(f) else None,
                    "volume": float(abs(np.linalg.det(np.array(s["cell"])))),
                }
            )
        except Exception:
            continue
    return out


# ----------------------------------------------------------------------------- per-kind analysis
def analyze_pw_run(d: Path, st: dict[str, Any], include_traj: bool = True) -> dict[str, Any]:
    out_path = d / st.get("cwd", ".") / st["output_name"]
    text = _read(out_path) or ""
    r = parse_pw_output(text)
    res: dict[str, Any] = {"summary": {k: v for k, v in r.items() if k not in ("ionic_steps", "bands_at_k")}}
    res["scf"] = [
        {
            "step": i + 1,
            "energy_ev": s["energy_ev"],
            "n_scf": s["n_scf"],
            "converged": s["converged"],
            "max_force": s["max_force"],
            "total_force": s["total_force"],
            "pressure_kbar": s["pressure_kbar"],
            "magnetization": s["magnetization"],
            "iterations": [
                {
                    "iter": it["iter"],
                    "energy_ev": (it["energy_ry"] or 0) * RY_EV if it["energy_ry"] is not None else None,
                    "accuracy_ry": it["accuracy_ry"],
                    "cpu_s": it["cpu_s"],
                }
                for it in s["scf"]
            ],
        }
        for i, s in enumerate(r["ionic_steps"])
    ]
    last = r["ionic_steps"][-1] if r["ionic_steps"] else None
    if last:
        res["forces_ry_bohr"] = last["forces"]
        res["stress_kbar"] = last["stress_kbar"]
    xml_name = Path(st["output_name"]).with_suffix(".xml").name
    xml = d / st.get("cwd", ".") / xml_name
    if xml.exists():
        try:
            x = parse_pw_xml(xml.read_bytes())
            res["xml"] = {k: v for k, v in x.items() if k != "bands"}
            if "bands" in x:
                b = x["bands"]
                res["gap"] = band_gap(
                    b["eigenvalues_ev"], b.get("homo_ev"), b.get("fermi_energy_ev"), b.get("kpoints_2pi_alat")
                )
                res["xml"]["fermi_energy_ev"] = b.get("fermi_energy_ev")
                res["xml"]["homo_ev"] = b.get("homo_ev")
                res["xml"]["lumo_ev"] = b.get("lumo_ev")
        except Exception as exc:
            res["xml_error"] = str(exc)
    if include_traj and len(r["ionic_steps"]) > 1:
        res["trajectory"] = _trajectory(text)
    return res


def analyze_bands(d: Path, wf: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    res: dict[str, Any] = {}
    scf_xml = d / wf.get("scf_xml", "scf.xml")
    bands_xml = d / wf.get("bands_xml", "bands.xml")
    ef = None
    ref_kind = "fermi"
    scf_info = None
    if scf_xml.exists():
        try:
            sx = parse_pw_xml(scf_xml.read_bytes())
            scf_info = sx.get("bands") or {}
            if (
                scf_info.get("homo_ev") is not None
                and scf_info.get("lumo_ev") is None
                and scf_info.get("fermi_energy_ev") is None
            ):
                ef, ref_kind = scf_info["homo_ev"], "vbm"
            else:
                ef = (
                    scf_info.get("fermi_energy_ev")
                    if scf_info.get("fermi_energy_ev") is not None
                    else scf_info.get("homo_ev")
                )
        except Exception as exc:
            res["scf_xml_error"] = str(exc)
    if ef is None:
        txt = _read(d / wf.get("scf_output", "scf.out"))
        if txt:
            r = parse_pw_output(txt)
            ef = r.get("fermi_energy_ev") if r.get("fermi_energy_ev") is not None else r.get("homo_ev")
    if not bands_xml.exists():
        gnu = d / "bands.dat.gnu"
        if gnu.exists():
            g = P.parse_bands_gnu(gnu.read_text())
            res.update(
                {"x": g["x"], "bands": [list(map(list, zip(*g["bands"])))], "ticks": [], "source": "bands.dat.gnu"}
            )
        else:
            raise FileNotFoundError("band-structure XML not found (did the bands step finish?)")
    else:
        bx = parse_pw_xml(bands_xml.read_bytes())["bands"]
        kc = np.array(bx["kpoints_cart_inv_a"])
        kp = wf.get("kpath") or {}
        counts = [int(ln.split()[3]) for ln in kp.get("lines", [])] if kp.get("lines") else None
        pdist = P.path_distances(kc, kp.get("labels"), counts)
        res.update(
            {
                "x": pdist["x"],
                "ticks": pdist["ticks"],
                "breaks": pdist["breaks"],
                "bands": bx["eigenvalues_ev"],
                "source": "bands.xml",
                "lsda": bx["lsda"],
            }
        )
        if ef is not None and scf_info is not None:
            gap = band_gap(
                bx["eigenvalues_ev"],
                scf_info.get("homo_ev") if ref_kind == "vbm" or scf_info.get("lumo_ev") else None,
                ef,
                bx.get("kpoints_2pi_alat"),
            )
            res["gap"] = gap
    res["reference_ev"] = ef
    res["reference_kind"] = ref_kind
    return res


def analyze_dos(d: Path, wf: dict[str, Any]) -> dict[str, Any]:
    res: dict[str, Any] = {}
    dos_file = d / wf.get("dos_file", "")
    if dos_file.is_file():
        res["dos"] = P.parse_dos(dos_file.read_text())
    prefix = wf.get("pdos_prefix")
    files = {}
    if prefix:
        for p in d.iterdir():
            if p.name.startswith(prefix + ".pdos_"):
                files[p.name] = p.read_text(errors="replace")
    if files:
        res["pdos"] = P.parse_pdos_files(files)
    ef = (res.get("dos") or {}).get("fermi_energy_ev")
    if ef is None:
        for name in ("nscf.out", "scf.out"):
            t = _read(d / name)
            if t:
                r = parse_pw_output(t)
                ef = r.get("fermi_energy_ev") if r.get("fermi_energy_ev") is not None else r.get("homo_ev")
                if ef is not None:
                    break
    res["fermi_energy_ev"] = ef
    if not res.get("dos") and not res.get("pdos"):
        raise FileNotFoundError("no DOS output files found")
    return res


PHDOS_SIGMA_CM1 = 4.0


def _checked_phonon_dos(dos: dict[str, Any], grid_file: Path) -> dict[str, Any]:
    """Check matdyn's DOS against its documented normalisation (integral = 3*nat modes).

    With the QE 7.6 conda-forge build we measured (Si, 2 atoms) that the tetrahedron DOS integrates
    to 3*nat but can be all-NaN for some force constants, and that the Gaussian (degauss > 0) DOS
    integrates to ~0.70 * 3*nat. When matdyn's DOS is NaN or off by > 5 %, it is replaced by a
    Gaussian DOS computed here from matdyn's grid frequencies and q weights (the .dos.freq file).
    """
    if grid_file.is_file():
        try:
            g = P.parse_matdyn_freq(grid_file.read_text())
        except ValueError:
            g = None
        if g and g.get("col4"):
            n_modes = g["nbnd"]
            x = np.array(dos["freq_cm1"], dtype=float)
            y = np.array([np.nan if v is None else v for v in dos["dos"]], dtype=float)
            integral = float(np.trapezoid(y, x)) if np.isfinite(y).all() and len(x) > 1 else float("nan")
            dos["integral"] = integral
            dos["expected_integral"] = n_modes
            if not math.isfinite(integral) or abs(integral - n_modes) > 0.05 * n_modes:
                fb = P.phonon_dos_from_grid(np.array(g["freq_cm1"]), np.array(g["col4"]), PHDOS_SIGMA_CM1)
                fb_int = float(np.trapezoid(fb["dos"], fb["freq_cm1"]))
                problem = "contains NaN" if not math.isfinite(integral) else f"integrates to {integral:.2f}"
                fb.update(
                    integral=fb_int,
                    expected_integral=n_modes,
                    source="qestudio",
                    note=(
                        f"matdyn.x DOS {problem} instead of 3·nat = {n_modes}; "
                        f"showing a Gaussian DOS (σ = {PHDOS_SIGMA_CM1:g} cm⁻¹) "
                        "computed by QE Studio from matdyn's grid frequencies and weights. Projected DOS omitted."
                    ),
                )
                return fb
    dos.setdefault("source", "matdyn")
    return dos


def analyze_phonon(d: Path, wf: dict[str, Any]) -> dict[str, Any]:
    res: dict[str, Any] = {}
    fq = d / wf.get("freq_file", "")
    if fq.is_file():
        f = P.parse_matdyn_freq(fq.read_text())
        # q in cartesian 2pi/alat -> distances using alat-relative units (shape is what matters)
        q = np.array(f["q_2pi_alat"])
        kp = wf.get("kpath") or {}
        counts = [int(ln.split()[3]) for ln in kp.get("lines", [])] if kp.get("lines") else None
        pdist = P.path_distances(q, kp.get("labels"), counts)
        res["dispersion"] = {
            "x": pdist["x"],
            "ticks": pdist["ticks"],
            "breaks": pdist["breaks"],
            "freq_cm1": f["freq_cm1"],
            "min_freq_cm1": f["min_freq_cm1"],
        }
        res["imaginary_modes"] = f["min_freq_cm1"] < -5.0
    pd = d / wf.get("phdos_file", "")
    if pd.is_file():
        grid = wf.get("dos_freq_file") or (f"{wf['prefix']}.dos.freq" if wf.get("prefix") else "")
        res["dos"] = _checked_phonon_dos(P.parse_phdos(pd.read_text()), d / grid)
    ph = _read(d / "ph.out")
    if ph:
        res["ph"] = parse_generic_output(ph, "ph")
    if not res:
        raise FileNotFoundError("no phonon output files found")
    return res


def analyze_convergence(d: Path, wf: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    nat = max(1, int(wf.get("nat", 1)))
    rows = []
    for pt, st in zip(wf.get("points", []), steps):
        txt = _read(d / st.get("cwd", ".") / st["output_name"])
        row: dict[str, Any] = {
            "label": pt["label"],
            "value": pt["value"],
            "energy_ev": None,
            "energy_per_atom_ev": None,
            "pressure_kbar": None,
            "max_force": None,
            "wall_s": None,
            "status": "missing",
        }
        if txt:
            r = parse_pw_output(txt)
            row["status"] = r["status"]
            if r.get("final_energy_ev") is not None:
                row["energy_ev"] = r["final_energy_ev"]
                row["energy_per_atom_ev"] = r["final_energy_ev"] / nat
            if r["ionic_steps"]:
                last = r["ionic_steps"][-1]
                row["pressure_kbar"] = last["pressure_kbar"]
                row["max_force"] = last["max_force"]
            row["wall_s"] = r.get("wall_time_s")
        rows.append(row)
    ref = next((r for r in reversed(rows) if r["energy_per_atom_ev"] is not None), None)
    for r in rows:
        if ref and r["energy_per_atom_ev"] is not None:
            r["delta_mev_per_atom"] = (r["energy_per_atom_ev"] - ref["energy_per_atom_ev"]) * 1000
            r["delta_p_kbar"] = (
                (r["pressure_kbar"] - ref["pressure_kbar"])
                if (r["pressure_kbar"] is not None and ref["pressure_kbar"] is not None)
                else None
            )
        else:
            r["delta_mev_per_atom"] = None
            r["delta_p_kbar"] = None
    rec = None
    for thr in (1.0,):
        for i, r in enumerate(rows):
            tail = rows[i:]
            if all(t["delta_mev_per_atom"] is not None and abs(t["delta_mev_per_atom"]) < thr for t in tail):
                rec = {
                    "label": r["label"],
                    "value": r["value"],
                    "threshold_mev_per_atom": thr,
                    "note": "smallest value whose energy (and all larger values) is within 1 meV/atom of the most "
                    "converged point; also check forces/stress if you need them",
                }
                break
    return {"parameter": wf.get("parameter"), "rows": rows, "recommended": rec}


def analyze_eos(d: Path, wf: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    from ase.eos import EquationOfState

    vols, ens, rows = [], [], []
    for pt, st in zip(wf.get("points", []), steps):
        txt = _read(d / st.get("cwd", ".") / st["output_name"])
        e = None
        if txt:
            r = parse_pw_output(txt)
            e = r.get("final_energy_ev")
            if r.get("relax") and r["relax"].get("energies_ev"):
                e = r["relax"]["energies_ev"][-1]
        rows.append({"volume": pt["volume"], "energy_ev": e})
        if e is not None:
            vols.append(pt["volume"])
            ens.append(e)
    res: dict[str, Any] = {"points": rows, "fit": None}
    if len(vols) >= 5:
        try:
            eos = EquationOfState(vols, ens, eos="birchmurnaghan")
            v0, e0, B = eos.fit()
            params = eos.eos_parameters if hasattr(eos, "eos_parameters") else None
            bp = None
            if params is not None and len(params) >= 3:
                bp = float(params[2])
            vfit = np.linspace(min(vols), max(vols), 120)
            efit = eos.func(vfit, *eos.eos_parameters) if hasattr(eos, "func") and params is not None else None
            nat = max(1, int(wf.get("nat", 1)))
            res["fit"] = {
                "eos": "Birch-Murnaghan (3rd order)",
                "v0": float(v0),
                "e0_ev": float(e0),
                "B0_GPa": float(B * EV_PER_A3_TO_GPA),
                "B0_prime": bp,
                "v0_per_atom": float(v0) / nat,
                "a0_cubic_equiv": float(v0) ** (1 / 3),
                "curve": {"volume": vfit.tolist(), "energy_ev": efit.tolist() if efit is not None else None},
            }
            if not (min(vols) < v0 < max(vols)):
                res["fit"]["warning"] = "minimum lies outside the sampled volume range; extend the range"
        except Exception as exc:
            res["fit_error"] = str(exc)
    else:
        res["fit_error"] = f"need >= 5 converged points (have {len(vols)})"
    return res


def analyze_density(d: Path, wf: dict[str, Any]) -> dict[str, Any]:
    cube = d / wf.get("cube", "")
    if not cube.is_file():
        raise FileNotFoundError("cube file not found")
    c = P.parse_cube(cube.read_text())
    return {
        "file": cube.name,
        "shape": c["shape"],
        "stats": c["stats"],
        "levels": P.suggest_levels(c),
        "atoms": c["atoms"],
        "cell": c["cell"].tolist(),
        "stride": c["stride"],
        "plot_num": wf.get("plot_num"),
    }


def analyze_job(local_dir: Path, steps: list[dict[str, Any]], workflow: dict[str, Any]) -> dict[str, Any]:
    kind = (workflow or {}).get("kind") or "custom"
    res: dict[str, Any] = {"kind": kind, "steps": [step_summary(local_dir, st) for st in steps]}
    try:
        if kind in ("scf", "relax", "vc-relax", "md", "vc-md", "nscf", "custom"):
            pw_steps = [s for s in steps if s.get("program") == "pw.x"]
            if pw_steps:
                res["pw"] = analyze_pw_run(local_dir, pw_steps[-1])
        elif kind == "bands":
            res["bands"] = analyze_bands(local_dir, workflow, steps)
            res["pw"] = analyze_pw_run(local_dir, steps[0], include_traj=False)
        elif kind == "dos":
            res["dos"] = analyze_dos(local_dir, workflow)
            res["pw"] = analyze_pw_run(local_dir, steps[0], include_traj=False)
        elif kind == "phonon":
            res["phonon"] = analyze_phonon(local_dir, workflow)
            res["pw"] = analyze_pw_run(local_dir, steps[0], include_traj=False)
        elif kind == "convergence":
            res["convergence"] = analyze_convergence(local_dir, workflow, steps)
        elif kind == "eos":
            res["eos"] = analyze_eos(local_dir, workflow, steps)
        elif kind == "density":
            res["density"] = analyze_density(local_dir, workflow)
            res["pw"] = analyze_pw_run(local_dir, steps[0], include_traj=False)
    except FileNotFoundError as exc:
        res["error"] = str(exc)
    except Exception as exc:
        log.exception("analysis failed")
        res["error"] = f"analysis failed: {exc}"
    return sanitize(res)


def parse_uploaded(name: str, text: str) -> dict[str, Any]:
    """Analyze a single user-uploaded output file (no job context)."""
    low = name.lower()
    if "Program PWSCF" in text[:5000] or (low.endswith((".pwo", ".out")) and "PWSCF" in text):
        r = parse_pw_output(text)
        steps = r.pop("ionic_steps")
        r.pop("bands_at_k", None)
        return sanitize(
            {
                "type": "pw",
                "summary": r,
                "scf": [
                    {
                        "step": i + 1,
                        "energy_ev": s["energy_ev"],
                        "iterations": [
                            {
                                "iter": it["iter"],
                                "energy_ev": (it["energy_ry"] or 0) * RY_EV if it["energy_ry"] else None,
                                "accuracy_ry": it["accuracy_ry"],
                            }
                            for it in s["scf"]
                        ],
                        "max_force": s["max_force"],
                        "pressure_kbar": s["pressure_kbar"],
                    }
                    for i, s in enumerate(steps)
                ],
                "trajectory": _trajectory(text) if len(steps) > 1 else None,
            }
        )
    if text.lstrip().startswith("<?xml") or "<qes:espresso" in text[:2000]:
        x = parse_pw_xml(text.encode())
        if "bands" in x:
            b = x["bands"]
            x["gap"] = band_gap(
                b["eigenvalues_ev"], b.get("homo_ev"), b.get("fermi_energy_ev"), b.get("kpoints_2pi_alat")
            )
            kc = np.array(b["kpoints_cart_inv_a"])
            x["path"] = P.path_distances(kc)
        return sanitize({"type": "xml", **x})
    if "&plot nbnd" in text[:200]:
        f = P.parse_matdyn_freq(text)
        pdist = P.path_distances(np.array(f["q_2pi_alat"]))
        return sanitize({"type": "phonon_freq", **f, "x": pdist["x"]})
    if "EFermi" in text[:300] and ("dos(E)" in text[:300] or "dosup" in text[:300]):
        return sanitize({"type": "dos", **P.parse_dos(text)})
    if ".pdos_" in low:
        return sanitize({"type": "pdos", **P.parse_pdos_files({name: text})})
    if re.search(r"Frequency\[cm\^-1\]", text[:300]):
        return sanitize({"type": "phdos", **P.parse_phdos(text)})
    if low.endswith(".cube"):
        c = P.parse_cube(text)
        return sanitize({"type": "cube", "shape": c["shape"], "stats": c["stats"], "levels": P.suggest_levels(c)})
    if low.endswith(".gnu"):
        return sanitize({"type": "bands_gnu", **P.parse_bands_gnu(text)})
    for prog in ("PHONON", "POST-PROC", "DOS", "PROJWFC", "BANDS", "MATDYN", "Q2R"):
        if f"Program {prog}" in text[:5000]:
            return sanitize({"type": "generic", **parse_generic_output(text, prog.lower())})
    raise ValueError("unrecognized output format")

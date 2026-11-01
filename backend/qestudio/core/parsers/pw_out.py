"""Parser for pw.x standard output (text).

Robust to truncated (still running / crashed) files: everything parsed so far is
returned, and `status` tells whether the run finished, failed or is incomplete.
Energies are converted to eV in the `*_ev` fields; raw Ry values are kept.
"""

from __future__ import annotations

import re
from typing import Any

from ..units import RY_EV

_F = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eEdD][-+]?\d+)?"
RE = {
    "version": re.compile(r"Program PWSCF v\.?\s*(\S+)\s+starts on\s+(.*)"),
    "mpi": re.compile(r"Number of MPI processes:\s+(\d+)"),
    "threads": re.compile(r"Threads/MPI process:\s+(\d+)"),
    "pools": re.compile(r"K-points division:\s+npool\s+=\s+(\d+)"),
    "alat": re.compile(r"lattice parameter \(alat\)\s+=\s+(" + _F + r")\s+a\.u\."),
    "volume": re.compile(r"unit-cell volume\s+=\s+(" + _F + r")\s+\(a\.u\.\)\^3"),
    "nat": re.compile(r"number of atoms/cell\s+=\s+(\d+)"),
    "ntyp": re.compile(r"number of atomic types\s+=\s+(\d+)"),
    "nelec": re.compile(r"number of electrons\s+=\s+(" + _F + ")"),
    "nbnd": re.compile(r"number of Kohn-Sham states=\s+(\d+)"),
    "ecutwfc": re.compile(r"kinetic-energy cutoff\s+=\s+(" + _F + r")\s+Ry"),
    "ecutrho": re.compile(r"charge density cutoff\s+=\s+(" + _F + r")\s+Ry"),
    "xc": re.compile(r"Exchange-correlation\s*=\s*(.+)"),
    "nks": re.compile(r"number of k points=\s+(\d+)"),
    "calc_nscf": re.compile(r"Band Structure Calculation"),
    "iter": re.compile(r"iteration #\s*(\d+)\s+ecut=\s*(" + _F + r")\s+Ry\s+beta=\s*(" + _F + ")"),
    "etot_iter": re.compile(r"^\s+total energy\s+=\s+(" + _F + r")\s+Ry"),
    "etot_final": re.compile(r"^!\s+total energy\s+=\s+(" + _F + r")\s+Ry"),
    "scf_acc": re.compile(r"estimated scf accuracy\s+<\s+(" + _F + r")\s+Ry"),
    "cpu": re.compile(r"total cpu time spent up to now is\s+(" + _F + r")\s+secs"),
    "converged": re.compile(r"convergence has been achieved in\s+(\d+)\s+iterations"),
    "not_converged": re.compile(r"convergence NOT achieved after\s+(\d+)\s+iterations"),
    "efermi": re.compile(r"the Fermi energy is\s+(" + _F + r")\s+ev"),
    "efermi2": re.compile(r"the spin up/dw Fermi energies are\s+(" + _F + r")\s+(" + _F + r")\s+ev"),
    "homo_lumo": re.compile(r"highest occupied, lowest unoccupied level \(ev\):\s+(" + _F + r")\s+(" + _F + ")"),
    "homo": re.compile(r"highest occupied level \(ev\):\s+(" + _F + ")"),
    "force": re.compile(r"atom\s+(\d+)\s+type\s+(\d+)\s+force =\s+(" + _F + r")\s+(" + _F + r")\s+(" + _F + ")"),
    "total_force": re.compile(r"Total force =\s+(" + _F + ")"),
    "pressure": re.compile(r"total\s+stress\s+\(Ry/bohr\*\*3\)\s+\(kbar\)\s+P=\s*(" + _F + ")"),
    "tot_mag": re.compile(
        r"total magnetization\s+=\s+(" + _F + r")(?:\s+(" + _F + r")\s+(" + _F + r"))?\s+Bohr mag/cell"
    ),
    "abs_mag": re.compile(r"absolute magnetization\s+=\s+(" + _F + r")\s+Bohr mag/cell"),
    "enthalpy": re.compile(r"enthalpy new\s+=\s+(" + _F + r")\s+Ry"),
    "final_enthalpy": re.compile(r"Final (?:enthalpy|energy)\s+=\s+(" + _F + r")\s+Ry"),
    "bfgs_conv": re.compile(r"bfgs converged in\s+(\d+)\s+scf cycles and\s+(\d+)\s+bfgs steps"),
    "bfgs_end": re.compile(r"End of BFGS Geometry Optimization"),
    "max_steps": re.compile(r"The maximum number of steps has been reached"),
    "timing": re.compile(r"PWSCF\s+:\s+(.+?)\s+CPU\s+(.+?)\s+WALL"),
    "job_done": re.compile(r"JOB DONE\."),
    "kpt": re.compile(r"^\s+k =\s*(" + _F + r")\s*(" + _F + r")\s*(" + _F + r")\s*\(\s*\d+ PWs\)\s+bands \(ev\):"),
    "spin_up": re.compile(r"-+\s*SPIN UP\s*-+"),
    "spin_dw": re.compile(r"-+\s*SPIN DOWN\s*-+"),
    "warning": re.compile(r"^\s*(?:Message from routine|WARNING|Warning)[:\s].*"),
    "smearing_contrib": re.compile(r"smearing contrib\. \(-TS\)\s+=\s+(" + _F + r")\s+Ry"),
    "ionic_md": re.compile(r"Entering Dynamics:\s+iteration =\s+(\d+)"),
    "temperature": re.compile(r"temperature\s+=\s+(" + _F + r")\s+K"),
}


def _f(x: str) -> float:
    return float(x.replace("d", "e").replace("D", "e"))


def _hms_to_s(t: str) -> float | None:
    """'1h 2m', '3m45.2s', '0.49s' -> seconds."""
    t = t.strip()
    total = 0.0
    found = False
    for val, unit in re.findall(r"(" + _F + r")\s*([hms])", t):
        found = True
        total += _f(val) * {"h": 3600, "m": 60, "s": 1}[unit]
    return total if found else None


def parse_pw_output(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {
        "program": "pw",
        "version": None,
        "started": None,
        "mpi_processes": None,
        "threads": None,
        "alat_bohr": None,
        "volume_bohr3": None,
        "nat": None,
        "ntyp": None,
        "nelec": None,
        "nbnd": None,
        "ecutwfc": None,
        "ecutrho": None,
        "xc": None,
        "nks": None,
        "ionic_steps": [],
        "scf_converged": None,
        "job_done": False,
        "status": "incomplete",
        "fermi_energy_ev": None,
        "fermi_energies_ev": None,
        "homo_ev": None,
        "lumo_ev": None,
        "final_energy_ry": None,
        "final_energy_ev": None,
        "total_magnetization": None,
        "absolute_magnetization": None,
        "wall_time_s": None,
        "cpu_time_s": None,
        "errors": [],
        "warnings": [],
        "relax": None,
        "bands_at_k": None,
    }
    lines = text.splitlines()
    cur: dict[str, Any] | None = None  # current ionic step

    def new_step() -> dict[str, Any]:
        return {
            "scf": [],
            "energy_ry": None,
            "converged": None,
            "n_scf": 0,
            "forces": [],
            "total_force": None,
            "pressure_kbar": None,
            "stress_kbar": None,
            "magnetization": None,
            "abs_magnetization": None,
            "enthalpy_ry": None,
            "cpu_s": None,
            "smearing_ry": None,
        }

    i, n = 0, len(lines)
    kblock: list[dict[str, Any]] | None = None
    kpts_bands: dict[int, list[dict[str, Any]]] = {}
    while i < n:
        ln = lines[i]
        m = RE["iter"].search(ln)
        if m:
            if cur is None or cur.get("_done"):
                cur = new_step()
                out["ionic_steps"].append(cur)
            cur["scf"].append(
                {"iter": int(m.group(1)), "energy_ry": None, "accuracy_ry": None, "beta": _f(m.group(3)), "cpu_s": None}
            )
            i += 1
            continue
        if cur is not None and cur["scf"]:
            m = RE["etot_iter"].search(ln)
            if m and cur["scf"][-1]["energy_ry"] is None:
                cur["scf"][-1]["energy_ry"] = _f(m.group(1))
                i += 1
                continue
            m = RE["scf_acc"].search(ln)
            if m and not cur.get("_done") and cur["scf"][-1]["accuracy_ry"] is None:
                cur["scf"][-1]["accuracy_ry"] = _f(m.group(1))
                i += 1
                continue
            m = RE["cpu"].search(ln)
            if m and not cur.get("_done"):
                cur["scf"][-1]["cpu_s"] = _f(m.group(1))
                cur["cpu_s"] = _f(m.group(1))
                i += 1
                continue
        m = RE["etot_final"].search(ln)
        if m:
            if cur is None:
                cur = new_step()
                out["ionic_steps"].append(cur)
            cur["energy_ry"] = _f(m.group(1))
            if cur["scf"] and cur["scf"][-1]["energy_ry"] is None:
                cur["scf"][-1]["energy_ry"] = cur["energy_ry"]
            out["final_energy_ry"] = cur["energy_ry"]
            i += 1
            continue
        m = RE["converged"].search(ln)
        if m:
            if cur is None:
                cur = new_step()
                out["ionic_steps"].append(cur)
            cur["converged"] = True
            cur["n_scf"] = int(m.group(1))
            cur["_done"] = True
            out["scf_converged"] = True
            i += 1
            continue
        m = RE["not_converged"].search(ln)
        if m:
            if cur is not None:
                cur["converged"] = False
                cur["n_scf"] = int(m.group(1))
                cur["_done"] = True
            out["scf_converged"] = False
            out["errors"].append(ln.strip())
            i += 1
            continue
        m = RE["force"].search(ln)
        if m and cur is not None and "force =" in ln and "Ry/au" not in ln:
            # only the first "Forces acting on atoms" block (total forces) is collected
            if not cur.get("_forces_closed"):
                cur["forces"].append([_f(m.group(3)), _f(m.group(4)), _f(m.group(5))])
            i += 1
            continue
        if (cur is not None and "The non-local contrib." in ln) or (cur is not None and "The ionic contribution" in ln):
            cur["_forces_closed"] = True
        m = RE["total_force"].search(ln)
        if m and cur is not None:
            cur["total_force"] = _f(m.group(1))
            cur["_forces_closed"] = True
            i += 1
            continue
        m = RE["pressure"].search(ln)
        if m and cur is not None:
            cur["pressure_kbar"] = _f(m.group(1))
            try:
                rows = [lines[i + k].split() for k in (1, 2, 3)]
                cur["stress_kbar"] = [[_f(x) for x in r[3:6]] for r in rows]
            except (IndexError, ValueError):
                pass
            i += 4
            continue
        m = RE["tot_mag"].search(ln)
        if m:
            vals = [_f(x) for x in m.groups() if x is not None]
            val = vals[0] if len(vals) == 1 else vals
            out["total_magnetization"] = val
            if cur is not None:
                cur["magnetization"] = val
            i += 1
            continue
        m = RE["abs_mag"].search(ln)
        if m:
            out["absolute_magnetization"] = _f(m.group(1))
            if cur is not None:
                cur["abs_magnetization"] = _f(m.group(1))
            i += 1
            continue
        m = RE["smearing_contrib"].search(ln)
        if m and cur is not None:
            cur["smearing_ry"] = _f(m.group(1))
        m = RE["enthalpy"].search(ln)
        if m and cur is not None:
            cur["enthalpy_ry"] = _f(m.group(1))
        m = RE["efermi"].search(ln)
        if m:
            out["fermi_energy_ev"] = _f(m.group(1))
        m = RE["efermi2"].search(ln)
        if m:
            out["fermi_energies_ev"] = [_f(m.group(1)), _f(m.group(2))]
            out["fermi_energy_ev"] = max(out["fermi_energies_ev"])
        m = RE["homo_lumo"].search(ln)
        if m:
            out["homo_ev"], out["lumo_ev"] = _f(m.group(1)), _f(m.group(2))
        else:
            m = RE["homo"].search(ln)
            if m:
                out["homo_ev"] = _f(m.group(1))
        # band energies printed at the end of each scf / nscf
        if "End of self-consistent calculation" in ln or "End of band structure calculation" in ln:
            kpts_bands = {}
            kblock = []
            kpts_bands[0] = kblock
        if RE["spin_up"].search(ln) and kblock is not None:
            kblock = kpts_bands.setdefault(0, [])
        if RE["spin_dw"].search(ln) and kblock is not None:
            kblock = kpts_bands.setdefault(1, [])
        m = RE["kpt"].search(ln)
        if m and kblock is not None:
            vals: list[float] = []
            j = i + 1
            while j < n and not lines[j].strip():
                j += 1
            while (
                j < n
                and lines[j].strip()
                and not lines[j]
                .strip()
                .startswith(("k =", "occupation", "highest", "the Fermi", "the spin", "Writing"))
            ):
                for tok in re.findall(_F, lines[j]):
                    try:
                        vals.append(_f(tok))
                    except ValueError:
                        pass
                j += 1
            kblock.append({"k": [_f(m.group(1)), _f(m.group(2)), _f(m.group(3))], "e": vals})
            i = j
            continue
        if RE["bfgs_conv"].search(ln):
            mm = RE["bfgs_conv"].search(ln)
            out["relax"] = {
                **(out["relax"] or {}),
                "converged": True,
                "scf_cycles": int(mm.group(1)),
                "bfgs_steps": int(mm.group(2)),
            }
        if RE["max_steps"].search(ln):
            out["relax"] = {**(out["relax"] or {}), "converged": False, "message": ln.strip()}
            out["warnings"].append(ln.strip())
        m = RE["final_enthalpy"].search(ln)
        if m:
            out["relax"] = {**(out["relax"] or {}), "final_energy_ry": _f(m.group(1))}
        if "Begin final coordinates" in ln:
            block = []
            j = i + 1
            while j < n and "End final coordinates" not in lines[j]:
                block.append(lines[j])
                j += 1
            out["relax"] = {**(out["relax"] or {}), "final_coordinates": "\n".join(block).strip()}
            i = j + 1
            continue
        # errors (%%%%% block)
        if ln.strip().startswith("%%%%%%%%"):
            j = i + 1
            msg = []
            while j < n and not lines[j].strip().startswith("%%%%%%%%"):
                if lines[j].strip():
                    msg.append(lines[j].strip())
                j += 1
            if msg:
                out["errors"].append(" ".join(msg))
            i = j + 1
            continue
        if RE["warning"].match(ln) and len(out["warnings"]) < 50:
            w = ln.strip()
            if i + 1 < n and lines[i + 1].strip() and not RE["warning"].match(lines[i + 1]):
                w += " " + lines[i + 1].strip()
            if w not in out["warnings"]:
                out["warnings"].append(w)
        # header info
        for key in ("mpi", "threads", "alat", "volume", "nat", "ntyp", "nelec", "nbnd", "ecutwfc", "ecutrho", "nks"):
            m = RE[key].search(ln)
            if m:
                tgt = {
                    "mpi": "mpi_processes",
                    "threads": "threads",
                    "alat": "alat_bohr",
                    "volume": "volume_bohr3",
                    "nat": "nat",
                    "ntyp": "ntyp",
                    "nelec": "nelec",
                    "nbnd": "nbnd",
                    "ecutwfc": "ecutwfc",
                    "ecutrho": "ecutrho",
                    "nks": "nks",
                }[key]
                val = m.group(1)
                if out[tgt] is None:
                    out[tgt] = int(val) if key in ("mpi", "threads", "nat", "ntyp", "nbnd", "nks") else _f(val)
        m = RE["version"].search(ln)
        if m:
            out["version"], out["started"] = m.group(1), m.group(2).strip()
        m = RE["xc"].search(ln)
        if m and out["xc"] is None:
            out["xc"] = m.group(1).strip()
        m = RE["timing"].search(ln)
        if m:
            out["cpu_time_s"] = _hms_to_s(m.group(1))
            out["wall_time_s"] = _hms_to_s(m.group(2))
        if RE["job_done"].search(ln):
            out["job_done"] = True
        i += 1

    for st in out["ionic_steps"]:
        st.pop("_done", None)
        st.pop("_forces_closed", None)
        st["energy_ev"] = st["energy_ry"] * RY_EV if st["energy_ry"] is not None else None
        st["max_force"] = max((sum(c * c for c in f) ** 0.5 for f in st["forces"]), default=None)
    if out["final_energy_ry"] is not None:
        out["final_energy_ev"] = out["final_energy_ry"] * RY_EV
    if kpts_bands:
        out["bands_at_k"] = [kpts_bands[s] for s in sorted(kpts_bands)]
    # status
    if out["errors"] and any("Error" in e or "error" in e for e in out["errors"]):
        out["status"] = "error"
    elif out["job_done"]:
        out["status"] = "done" if out["scf_converged"] is not False else "not_converged"
    else:
        out["status"] = "incomplete"
    if out["relax"] and out["ionic_steps"]:
        out["relax"]["energies_ev"] = [s["energy_ev"] for s in out["ionic_steps"] if s["energy_ev"] is not None]
    if out["nbnd"] is not None and out["bands_at_k"]:
        # trim to nbnd (protect against stray numbers)
        for blk in out["bands_at_k"]:
            for kk in blk:
                kk["e"] = kk["e"][: out["nbnd"]]
    return out


def parse_generic_output(text: str, program: str) -> dict[str, Any]:
    """Minimal status/timing/error extraction for post-processing codes."""
    out: dict[str, Any] = {
        "program": program,
        "job_done": "JOB DONE." in text,
        "errors": [],
        "warnings": [],
        "wall_time_s": None,
        "cpu_time_s": None,
        "version": None,
    }
    m = re.search(r"Program\s+(\S+)\s+v\.?\s*(\S+)\s+starts", text)
    if m:
        out["version"] = m.group(2)
    blocks = re.findall(r"%{10,}\n(.*?)\n\s*%{10,}", text, re.S)
    for b in blocks:
        msg = " ".join(x.strip() for x in b.splitlines() if x.strip())
        if msg:
            out["errors"].append(msg)
    for ln in text.splitlines():
        if re.match(r"^\s*(?:Message from routine|WARNING|Warning)", ln) and len(out["warnings"]) < 30:
            out["warnings"].append(ln.strip())
    tm = re.findall(r"^\s*\S+\s+:\s+(.+?)\s+CPU\s+(.+?)\s+WALL\s*$", text, re.M)
    if tm:
        out["cpu_time_s"] = _hms_to_s(tm[-1][0])
        out["wall_time_s"] = _hms_to_s(tm[-1][1])
    if program == "ph":
        out["q_points"] = len(re.findall(r"Calculation of q\s*=", text))
        freqs = re.findall(r"freq \(\s*\d+\)\s*=\s*(" + _F + r")\s*\[THz\]\s*=\s*(" + _F + r")\s*\[cm-1\]", text)
        out["gamma_frequencies_cm1"] = [_f(b) for _a, b in freqs[:300]]
        out["n_irreps_done"] = len(re.findall(r"Convergence has been achieved", text))
        if "Dielectric constant in cartesian axis" in text:
            mm = re.search(r"Dielectric constant in cartesian axis\s*\n\s*\n((?:.*\n){3})", text)
            if mm:
                try:
                    out["epsilon"] = [[_f(x) for x in re.findall(_F, r)][:3] for r in mm.group(1).splitlines()]
                except ValueError:
                    pass
    out["status"] = "error" if out["errors"] else ("done" if out["job_done"] else "incomplete")
    return out

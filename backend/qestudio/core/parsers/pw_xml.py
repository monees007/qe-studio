"""Parser for the QE XML data file (prefix.xml / data-file-schema.xml, qes-1.0 schema)."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from typing import Any

import numpy as np

from ..units import BOHR_A, HA_EV


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _find(el: ET.Element | None, path: str) -> ET.Element | None:
    if el is None:
        return None
    cur = el
    for part in path.split("/"):
        nxt = None
        for c in cur:
            if _local(c.tag) == part:
                nxt = c
                break
        if nxt is None:
            return None
        cur = nxt
    return cur


def _findall(el: ET.Element | None, name: str) -> list[ET.Element]:
    if el is None:
        return []
    return [c for c in el if _local(c.tag) == name]


def _floats(el: ET.Element | None) -> list[float]:
    if el is None or el.text is None:
        return []
    return [float(x) for x in el.text.split()]


def _float(el: ET.Element | None) -> float | None:
    v = _floats(el)
    return v[0] if v else None


def _bool(el: ET.Element | None) -> bool:
    return el is not None and (el.text or "").strip().lower() == "true"


def parse_pw_xml(data: bytes | str) -> dict[str, Any]:
    root = ET.fromstring(data)
    out_el = _find(root, "output")
    if out_el is None:
        raise ValueError("XML has no <output> section (calculation did not finish?)")
    res: dict[str, Any] = {}
    # structure
    ast = _find(out_el, "atomic_structure")
    if ast is not None:
        alat = float(ast.get("alat", "0") or 0)
        cell = np.array([_floats(_find(ast, f"cell/a{i}")) for i in (1, 2, 3)]) * BOHR_A
        atoms = []
        for a in _findall(_find(ast, "atomic_positions"), "atom"):
            atoms.append({"species": a.get("name"), "xyz": (np.array(_floats(a)) * BOHR_A).tolist()})
        res["structure"] = {"cell": cell.tolist(), "alat_bohr": alat, "atoms": atoms}
    te = _find(out_el, "total_energy")
    if te is not None:
        res["total_energy_ev"] = (_float(_find(te, "etot")) or 0.0) * HA_EV
        for k in ("eband", "ehart", "etxc", "ewald", "demet"):
            v = _float(_find(te, k))
            if v is not None:
                res[f"{k}_ev"] = v * HA_EV
    mag = _find(out_el, "magnetization")
    if mag is not None:
        res["total_magnetization"] = _float(_find(mag, "total"))
        res["absolute_magnetization"] = _float(_find(mag, "absolute"))
    forces = _find(out_el, "forces")
    if forces is not None:
        f = np.array(_floats(forces)).reshape(-1, 3) * HA_EV / BOHR_A
        res["forces_ev_a"] = f.tolist()
    stress = _find(out_el, "stress")
    if stress is not None:
        s = np.array(_floats(stress)).reshape(3, 3)
        # Ha/bohr^3 -> kbar ; 1 Ha/bohr^3 = 2.9421015697e13 Pa = 2.9421015697e8 kbar
        res["stress_kbar"] = (s * 2.9421015697e8).tolist()
        res["pressure_kbar"] = float(np.trace(s) / 3 * 2.9421015697e8)
    bs = _find(out_el, "band_structure")
    if bs is not None:
        lsda = _bool(_find(bs, "lsda"))
        noncolin = _bool(_find(bs, "noncolin"))
        nbnd_el = _find(bs, "nbnd")
        nbnd = int(_float(nbnd_el)) if nbnd_el is not None else None
        nup = _find(bs, "nbnd_up")
        nelec = _float(_find(bs, "nelec"))
        ef = _float(_find(bs, "fermi_energy"))
        two = _floats(_find(bs, "two_fermi_energies"))
        homo = _float(_find(bs, "highestOccupiedLevel"))
        lumo = _float(_find(bs, "lowestUnoccupiedLevel"))
        kpts, weights, eigs, occs = [], [], [], []
        for ks in _findall(bs, "ks_energies"):
            kp = _find(ks, "k_point")
            kpts.append(_floats(kp))
            weights.append(float(kp.get("weight", "0")) if kp is not None else 0.0)
            eigs.append(_floats(_find(ks, "eigenvalues")))
            occs.append(_floats(_find(ks, "occupations")))
        e = np.array(eigs) * HA_EV if eigs else np.zeros((0, 0))
        if lsda:
            nu = int(_float(nup)) if nup is not None else e.shape[1] // 2
            bands = [e[:, :nu].tolist(), e[:, nu:].tolist()]
        else:
            bands = [e.tolist()]
        alat = res.get("structure", {}).get("alat_bohr") or 1.0
        res["bands"] = {
            "lsda": lsda,
            "noncolin": noncolin,
            "nbnd": nbnd,
            "nelec": nelec,
            "fermi_energy_ev": ef * HA_EV if ef is not None else None,
            "fermi_energies_ev": [x * HA_EV for x in two] if two else None,
            "homo_ev": homo * HA_EV if homo is not None else None,
            "lumo_ev": lumo * HA_EV if lumo is not None else None,
            "kpoints_2pi_alat": kpts,  # cartesian, units 2*pi/alat
            "kpoints_cart_inv_a": (np.array(kpts) * 2 * np.pi / (alat * BOHR_A)).tolist() if kpts else [],
            "weights": weights,
            "eigenvalues_ev": bands,  # [spin][k][band]
            "occupations": occs,
        }
    conv = _find(out_el, "convergence_info/scf_conv")
    if conv is not None:
        res["scf_converged"] = _bool(_find(conv, "convergence_achieved"))
        res["n_scf_steps"] = int(_float(_find(conv, "n_scf_steps")) or 0)
    es = _find(root, "exit_status")
    if es is not None and es.text:
        res["exit_status"] = int(es.text.strip())
    inp = _find(root, "input")
    if inp is not None:
        ctl = _find(inp, "control_variables")
        if ctl is not None:
            res["calculation"] = (
                (_find(ctl, "calculation").text or "").strip() if _find(ctl, "calculation") is not None else None
            )
            res["prefix"] = (_find(ctl, "prefix").text or "").strip() if _find(ctl, "prefix") is not None else None
    gi = _find(root, "general_info/creator")
    if gi is not None:
        res["creator"] = f"{gi.get('NAME', '')} {gi.get('VERSION', '')}".strip()
    return res


def band_gap(
    eigs_spin_k_b: list[list[list[float]]],
    homo: float | None = None,
    efermi: float | None = None,
    kpts: list[list[float]] | None = None,
) -> dict[str, Any] | None:
    """Gap from eigenvalues: bands entirely below/above the reference level."""
    ref = homo if homo is not None else efermi
    if ref is None or not eigs_spin_k_b:
        return None
    allk = (
        np.concatenate([np.array(s) for s in eigs_spin_k_b if len(s)], axis=1)
        if len(eigs_spin_k_b) > 1
        else np.array(eigs_spin_k_b[0])
    )
    if allk.size == 0:
        return None
    tol = 1e-4
    occ = np.where(allk <= ref + tol, allk, -np.inf)
    emp = np.where(allk > ref + tol, allk, np.inf)
    vbm = float(occ.max())
    cbm = float(emp.min())
    if not np.isfinite(vbm) or not np.isfinite(cbm):
        return None
    # metal check: a band crossing the reference level
    for b in range(allk.shape[1]):
        col = allk[:, b]
        if col.min() < ref - tol and col.max() > ref + tol:
            return {"gap_ev": 0.0, "metal": True, "vbm_ev": None, "cbm_ev": None, "direct": None}
    kv = int(np.unravel_index(np.argmax(occ), occ.shape)[0])
    kc = int(np.unravel_index(np.argmin(emp), emp.shape)[0])
    direct_gap = float(
        np.min(
            np.where(np.isfinite(emp.min(axis=1)), emp.min(axis=1), np.inf)
            - np.where(np.isfinite(occ.max(axis=1)), occ.max(axis=1), -np.inf)
        )
    )
    out = {
        "gap_ev": cbm - vbm,
        "metal": cbm - vbm < 1e-3,
        "vbm_ev": vbm,
        "cbm_ev": cbm,
        "direct": kv == kc,
        "k_vbm_index": kv,
        "k_cbm_index": kc,
        "direct_gap_ev": direct_gap,
    }
    if kpts:
        out["k_vbm"] = kpts[kv]
        out["k_cbm"] = kpts[kc]
    return out

"""Parsers for post-processing outputs: dos.x, projwfc.x (pdos), bands.x, matdyn.x
(frequencies, phonon DOS) and Gaussian cube files (pp.x output_format=6)."""

from __future__ import annotations

import math
import re
from collections import defaultdict
from typing import Any

import numpy as np

from ..units import BOHR_A

_F = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eEdD][-+]?\d+)?|NaN|nan|-?Infinity"


def _num(tok: str) -> float:
    try:
        return float(tok.replace("D", "E").replace("d", "e"))
    except ValueError:
        return float("nan")


def _table(text: str) -> np.ndarray:
    rows = []
    for ln in text.splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        rows.append([_num(t) for t in s.split()])
    if not rows:
        return np.zeros((0, 0))
    w = min(len(r) for r in rows)
    return np.array([r[:w] for r in rows], dtype=float)


def _clean(a: np.ndarray) -> list[float]:
    return [None if not math.isfinite(x) else float(x) for x in a]  # type: ignore[misc]


# ----------------------------------------------------------------------------- dos.x
def parse_dos(text: str) -> dict[str, Any]:
    head = text.splitlines()[0] if text else ""
    m = re.search(r"EFermi\s*=\s*(" + _F + ")", head)
    ef = _num(m.group(1)) if m else None
    tab = _table(text)
    if tab.size == 0:
        raise ValueError("empty DOS file")
    out: dict[str, Any] = {"fermi_energy_ev": ef, "energy_ev": tab[:, 0].tolist()}
    if "dosup" in head.lower() or tab.shape[1] >= 4:
        out["spin"] = True
        out["dos_up"] = _clean(tab[:, 1])
        out["dos_down"] = _clean(tab[:, 2])
        out["int_dos"] = _clean(tab[:, 3]) if tab.shape[1] > 3 else None
    else:
        out["spin"] = False
        out["dos"] = _clean(tab[:, 1])
        out["int_dos"] = _clean(tab[:, 2]) if tab.shape[1] > 2 else None
    out["has_nan"] = bool(np.isnan(tab[:, 1:]).any())
    return out


# ----------------------------------------------------------------------------- projwfc.x
_PDOS_NAME = re.compile(r"\.pdos_atm#(\d+)\(([^)]+)\)_wfc#(\d+)\(([^)]+)\)$")


def parse_pdos_files(files: dict[str, str]) -> dict[str, Any]:
    """files: {filename: text} for prefix.pdos_tot and prefix.pdos_atm#..._wfc#... files.

    Returns totals plus projections summed by element, by element+orbital and by atom.
    """
    tot_name = next((n for n in files if n.endswith("pdos_tot")), None)
    out: dict[str, Any] = {
        "energy_ev": None,
        "total": None,
        "by_element": {},
        "by_orbital": {},
        "by_atom": {},
        "spin": False,
    }
    if tot_name:
        head = files[tot_name].splitlines()[0]
        tab = _table(files[tot_name])
        out["energy_ev"] = tab[:, 0].tolist()
        if "dosup" in head.lower() or "ldosup" in head.lower():
            out["spin"] = True
            out["total"] = {"up": _clean(tab[:, 1]), "down": _clean(tab[:, 2])}
        else:
            out["total"] = {"dos": _clean(tab[:, 1])}
    agg_el: dict[str, Any] = defaultdict(lambda: None)
    agg_orb: dict[str, Any] = defaultdict(lambda: None)
    agg_atom: dict[str, Any] = defaultdict(lambda: None)
    for name, text in files.items():
        m = _PDOS_NAME.search(name)
        if not m:
            continue
        iat, el, _iwfc, orb = int(m.group(1)), m.group(2), int(m.group(3)), m.group(4)
        head = text.splitlines()[0].lower()
        tab = _table(text)
        if tab.size == 0:
            continue
        if out["energy_ev"] is None:
            out["energy_ev"] = tab[:, 0].tolist()
        spin = "ldosup" in head
        if spin:
            out["spin"] = True
            val = np.stack([tab[:, 1], tab[:, 2]])  # up, down
        else:
            val = tab[:, 1][None, :]
        orb_l = re.sub(r"_j[\d.]+$", "", orb)
        for agg, key in ((agg_el, el), (agg_orb, f"{el}-{orb_l}"), (agg_atom, f"{el}{iat}")):
            agg[key] = val if agg[key] is None else agg[key] + val
    for agg, dest in ((agg_el, "by_element"), (agg_orb, "by_orbital"), (agg_atom, "by_atom")):
        for k, v in agg.items():
            out[dest][k] = {"up": _clean(v[0]), "down": _clean(v[1])} if v.shape[0] == 2 else {"dos": _clean(v[0])}
    return out


# ----------------------------------------------------------------------------- bands.x
def parse_bands_gnu(text: str) -> dict[str, Any]:
    """bands.x 'filband.gnu': blocks of (k-distance, E) separated by blank lines, one block per band."""
    bands, cur = [], []
    for ln in text.splitlines():
        s = ln.split()
        if not s:
            if cur:
                bands.append(cur)
                cur = []
            continue
        cur.append((_num(s[0]), _num(s[1])))
    if cur:
        bands.append(cur)
    if not bands:
        raise ValueError("empty bands file")
    x = [p[0] for p in bands[0]]
    return {"x": x, "bands": [[p[1] for p in b] for b in bands]}  # [band][k]


# ----------------------------------------------------------------------------- matdyn.x
def parse_matdyn_freq(text: str) -> dict[str, Any]:
    """matdyn 'flfrq' file: '&plot nbnd= N, nks= M /' then, for every q-point, one line with the
    q coordinates (cartesian, 2pi/alat; QE >= 7 appends the path coordinate as a 4th number)
    followed by N frequencies (cm^-1) spread over one or more lines."""
    m = re.search(r"nbnd=\s*(\d+)\s*,\s*nks=\s*(\d+)", text)
    if not m:
        raise ValueError("not a matdyn frequency file")
    nbnd, nks = int(m.group(1)), int(m.group(2))
    body = text[m.end() :].split("/", 1)[-1]
    lines = [ln for ln in body.splitlines() if ln.strip()]
    q: list[list[float]] = []
    col4: list[float] = []
    fr: list[list[float]] = []
    i = 0
    while len(q) < nks and i < len(lines):
        qv = [_num(t) for t in re.findall(_F, lines[i])]
        if len(qv) < 3:
            raise ValueError(f"malformed q-point line: {lines[i]!r}")
        q.append(qv[:3])
        if len(qv) >= 4:
            col4.append(qv[3])
        i += 1
        vals: list[float] = []
        while len(vals) < nbnd and i < len(lines):
            vals += [_num(t) for t in re.findall(_F, lines[i])]
            i += 1
        if len(vals) < nbnd:
            raise ValueError("truncated frequency file")
        fr.append(vals[:nbnd])
    if len(q) < nks:
        raise ValueError(f"truncated frequency file ({len(q)} of {nks} q-points)")
    arr = np.array(fr, dtype=float)
    out = {"q_2pi_alat": q, "freq_cm1": arr.tolist(), "nbnd": nbnd, "nks": nks, "min_freq_cm1": float(np.nanmin(arr))}
    if len(col4) == nks:
        # path coordinate for a band path; the q-point weight (sum = 1) for a matdyn dos=.true. grid
        out["col4"] = col4
    return out


def phonon_dos_from_grid(
    freq_cm1: np.ndarray, weights: np.ndarray, sigma_cm1: float = 4.0, step_cm1: float = 1.0
) -> dict[str, Any]:
    """Gaussian-broadened phonon DOS from matdyn's irreducible grid frequencies and q weights.

    Normalised so that its integral is the number of modes (3*nat), the convention documented
    for matdyn's fldos output. Used when matdyn's own DOS is unusable (see analysis.analyze_phonon).
    """
    f = np.asarray(freq_cm1, dtype=float)
    w = np.asarray(weights, dtype=float)
    if f.ndim != 2 or f.shape[0] != w.shape[0] or not np.isfinite(f).all() or w.sum() <= 0:
        raise ValueError("invalid grid frequencies or weights")
    w = w / w.sum()
    lo = min(0.0, float(f.min())) - 5 * sigma_cm1
    hi = float(f.max()) + 5 * sigma_cm1
    x = np.arange(lo, hi + step_cm1, step_cm1)
    g = np.zeros_like(x)
    norm = 1.0 / (sigma_cm1 * math.sqrt(2.0 * math.pi))
    for wq, row in zip(w, f):
        for om in row:
            g += wq * norm * np.exp(-0.5 * ((x - om) / sigma_cm1) ** 2)
    return {"freq_cm1": x.tolist(), "dos": g.tolist(), "pdos": [], "has_nan": False}


def parse_phdos(text: str) -> dict[str, Any]:
    tab = _table(text)
    if tab.size == 0:
        raise ValueError("empty phonon DOS file")
    out = {
        "freq_cm1": tab[:, 0].tolist(),
        "dos": _clean(tab[:, 1]),
        "pdos": [_clean(tab[:, j]) for j in range(2, tab.shape[1])],
        "has_nan": bool(np.isnan(tab[:, 1]).any()),
    }
    return out


# ----------------------------------------------------------------------------- path distances
def path_distances(
    kcart: np.ndarray, labels: list[str] | None = None, counts: list[int] | None = None
) -> dict[str, Any]:
    """Cumulative distance along a k/q path with breaks.

    If `labels`/`counts` (crystal_b weights) are given, special-point indices are exact and
    weight-1 segments are treated as discontinuities. Otherwise large jumps are detected.
    """
    n = len(kcart)
    d = np.zeros(n)
    steps = np.linalg.norm(np.diff(kcart, axis=0), axis=1) if n > 1 else np.zeros(0)
    breaks: set[int] = set()  # index i means no line between i-1 and i
    ticks: list[dict[str, Any]] = []
    if labels and counts and len(labels) == len(counts):
        idx = [0]
        for c in counts[:-1]:
            idx.append(idx[-1] + int(c))
        if idx[-1] <= n - 1:
            for j, c in enumerate(counts[:-1]):
                if int(c) == 1:
                    breaks.add(idx[j] + 1)
            for i in range(1, n):
                d[i] = d[i - 1] + (0.0 if i in breaks else steps[i - 1])
            for j, lab in enumerate(labels):
                if idx[j] < n:
                    ticks.append({"x": float(d[idx[j]]), "label": "Γ" if lab == "G" else lab, "index": idx[j]})
            # merge labels at breaks: "K|U"
            merged: list[dict[str, Any]] = []
            for t in ticks:
                if merged and abs(merged[-1]["x"] - t["x"]) < 1e-9 and merged[-1]["label"] != t["label"]:
                    merged[-1]["label"] = merged[-1]["label"] + "|" + t["label"]
                else:
                    merged.append(t)
            return {"x": d.tolist(), "ticks": merged, "breaks": sorted(breaks)}
    if n > 2:
        med = float(np.median(steps[steps > 1e-8])) if np.any(steps > 1e-8) else 0.0
        for i in range(1, n):
            jump = med > 0 and steps[i - 1] > 4 * med
            if jump:
                breaks.add(i)
            d[i] = d[i - 1] + (0.0 if jump else steps[i - 1])
    return {"x": d.tolist(), "ticks": [], "breaks": sorted(breaks)}


# ----------------------------------------------------------------------------- cube
def parse_cube(text: str, max_points: int = 96**3) -> dict[str, Any]:
    lines = text.splitlines()
    if len(lines) < 7:
        raise ValueError("not a cube file")
    t = lines[2].split()
    natoms = int(t[0])
    origin = np.array([_num(x) for x in t[1:4]])
    vox, ns = [], []
    for k in range(3):
        p = lines[3 + k].split()
        ns.append(int(p[0]))
        vox.append([_num(x) for x in p[1:4]])
    unit_bohr = all(nn > 0 for nn in ns)
    ns = [abs(x) for x in ns]
    vox_a = np.array(vox) * (BOHR_A if unit_bohr else 1.0)
    origin = origin * (BOHR_A if unit_bohr else 1.0)
    nat = abs(natoms)
    atoms = []
    for k in range(nat):
        p = lines[6 + k].split()
        atoms.append(
            {
                "z": int(_num(p[0])),
                "xyz": (np.array([_num(x) for x in p[2:5]]) * (BOHR_A if unit_bohr else 1.0)).tolist(),
            }
        )
    start = 6 + nat + (1 if natoms < 0 else 0)
    data = np.array(" ".join(lines[start:]).split(), dtype=float)
    total = ns[0] * ns[1] * ns[2]
    if data.size < total:
        raise ValueError(f"cube data truncated ({data.size} < {total})")
    grid = data[:total].reshape(ns)  # x slowest, z fastest
    # downsample very large grids for interactive use
    stride = 1
    while (ns[0] // stride) * (ns[1] // stride) * (ns[2] // stride) > max_points:
        stride += 1
    if stride > 1:
        grid = grid[::stride, ::stride, ::stride]
        vox_a = vox_a * stride
    cell = vox_a * np.array(grid.shape)[:, None]
    dv = abs(np.linalg.det(vox_a))
    return {
        "grid": grid,
        "voxel": vox_a,
        "origin": origin,
        "cell": cell,
        "atoms": atoms,
        "stride": stride,
        "shape": list(grid.shape),
        "stats": {
            "min": float(grid.min()),
            "max": float(grid.max()),
            "mean": float(grid.mean()),
            "integral": float(grid.sum() * dv / BOHR_A**3),
        },
    }


def isosurface(cube: dict[str, Any], level: float, periodic: bool = True) -> dict[str, Any]:
    """Marching cubes on the (periodically padded) grid; vertices in Angstrom."""
    from skimage.measure import marching_cubes

    g = cube["grid"]
    if periodic:
        g = np.pad(g, ((0, 1), (0, 1), (0, 1)), mode="wrap")
    if not (g.min() < level < g.max()):
        return {"vertices": [], "faces": [], "normals": [], "level": level}
    verts, faces, normals, _ = marching_cubes(g, level=level, allow_degenerate=False)
    xyz = cube["origin"] + verts @ cube["voxel"]
    nrm = normals @ np.linalg.inv(cube["voxel"]).T
    nrm = nrm / np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    return {
        "vertices": np.round(xyz, 4).ravel().tolist(),
        "faces": faces.astype(int).ravel().tolist(),
        "normals": np.round(nrm, 3).ravel().tolist(),
        "level": level,
    }


def suggest_levels(cube: dict[str, Any]) -> list[float]:
    g = cube["grid"]
    pos = g[g > 0]
    if pos.size == 0:
        return [float(g.min() / 2)]
    return [float(np.percentile(pos, p)) for p in (50, 75, 90, 97)]

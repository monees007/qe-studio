"""Monkhorst-Pack meshes and band-structure paths."""

from __future__ import annotations

import itertools
import math
import re
from typing import Any

import numpy as np

from .model import (
    Structure,
    StructureError,
    reciprocal,
    to_atoms,
)
from .qe import fmt_num


def kmesh(s: Structure, kspacing: float) -> list[int]:
    """Monkhorst-Pack mesh with spacing (1/Angstrom, includes 2*pi)."""
    if kspacing <= 0:
        raise StructureError("k-spacing must be positive")
    rec = reciprocal(np.array(s["cell"]))
    mesh = [max(1, math.ceil(np.linalg.norm(b) / kspacing - 1e-6)) for b in rec]
    for i, periodic in enumerate(s.get("pbc", [True] * 3)):
        if not periodic:
            mesh[i] = 1
    return mesh


def kpath(s: Structure, npoints: int = 100, path: str | None = None) -> dict[str, Any]:
    """High-symmetry path (Setyawan-Curtarolo via ASE) as QE crystal_b points.

    Returns special points in crystal coordinates of the *given* cell, the path,
    QE K_POINTS lines (crystal_b) and segment metadata used to label band plots.
    """
    atoms = to_atoms(s)
    try:
        bp = atoms.cell.bandpath(path=path, npoints=max(npoints, 10), pbc=atoms.pbc)
    except Exception as exc:
        raise StructureError(f"could not determine a k-path: {exc}") from exc
    sp = {k: [float(x) for x in v] for k, v in bp.special_points.items()}
    rec = reciprocal(np.array(s["cell"]))
    segments = [seg for seg in _split_path(bp.path) if len(seg) >= 1]
    # lengths for proportional sampling
    seg_lens = []
    for seg in segments:
        for a, b in itertools.pairwise(seg):
            seg_lens.append(float(np.linalg.norm((np.array(sp[b]) - np.array(sp[a])) @ rec)))
    total = sum(seg_lens) or 1.0
    lines: list[str] = []
    labels: list[str] = []
    li = 0
    for seg in segments:
        for j, name in enumerate(seg):
            last_in_seg = j == len(seg) - 1
            if last_in_seg:
                n = 1  # jump to next segment's first point (or end)
            else:
                n = max(2, round(npoints * seg_lens[li] / total))
                li += 1
            k = sp[name]
            lines.append(f"{fmt_num(k[0], 8)} {fmt_num(k[1], 8)} {fmt_num(k[2], 8)} {n}")
            labels.append(name)
    return {
        "path": bp.path,
        "special_points": sp,
        "lines": lines,
        "labels": labels,
        "segments": segments,
        "card": "K_POINTS {crystal_b}\n" + f"{len(lines)}\n" + "\n".join(lines),
    }


def _split_path(path: str) -> list[list[str]]:
    out = []
    for seg in path.split(","):
        out.append(re.findall(r"[A-Z][a-z0-9]*'?|G", seg) if seg else [])
    return [s for s in out if s]

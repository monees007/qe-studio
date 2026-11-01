"""Symmetry analysis (spglib), cell transforms and structure builders."""

from __future__ import annotations

import logging
from typing import Any

import numpy as np

from ..units import AMU_G
from .model import (
    Structure,
    StructureError,
    from_atoms,
    label_to_element,
    lattice_params,
    normalize,
    species_order,
    to_atoms,
)

log = logging.getLogger(__name__)


# ----------------------------------------------------------------------------- symmetry
def _spg_cell(s: Structure):
    labels = species_order(s)
    cell = np.array(s["cell"])
    frac = np.array([x["xyz"] for x in s["sites"]]) @ np.linalg.inv(cell)
    nums = [labels.index(x["species"]) + 1 for x in s["sites"]]
    return (cell, frac, nums), labels


def _ds_get(ds, key):
    return getattr(ds, key) if hasattr(ds, key) else ds[key]


def _spglib():
    """Import spglib, opting in to exception-based errors (the default from spglib 3)."""
    import spglib
    import spglib.error

    if hasattr(spglib.error, "OLD_ERROR_HANDLING"):
        spglib.error.OLD_ERROR_HANDLING = False
    return spglib


def _spg_call(fn, *args, **kwargs):
    """Call a spglib function; None when it cannot find a solution (both error conventions)."""
    import spglib.error

    try:
        return fn(*args, **kwargs)
    except spglib.error.SpglibError as exc:
        log.debug("spglib: %s", exc)
        return None


def analyze(s: Structure, symprec: float = 1e-3) -> dict[str, Any]:
    spglib = _spglib()

    s = normalize(s)
    atoms = to_atoms(s)
    cell = np.array(s["cell"])
    lp = lattice_params(cell)
    mass = float(sum(s["species"][x["species"]]["mass"] for x in s["sites"]))
    density = mass * AMU_G * 1e24 / lp["volume"] if lp["volume"] > 0 else None  # g/cm^3 (1 A^3 = 1e-24 cm^3)
    out: dict[str, Any] = {
        "formula": atoms.get_chemical_formula(mode="hill"),
        "reduced_formula": atoms.get_chemical_formula(mode="hill", empirical=True),
        "natoms": len(atoms),
        "lattice": lp,
        "density": density,
        "species": species_order(s),
        "min_distance": None,
    }
    if 1 < len(atoms) <= 400:
        d = atoms.get_all_distances(mic=any(atoms.pbc))
        np.fill_diagonal(d, np.inf)
        out["min_distance"] = float(d.min())
    if all(s["pbc"]):
        spg, _labels = _spg_cell(s)
        ds = _spg_call(spglib.get_symmetry_dataset, spg, symprec=symprec)
        if ds is not None:
            out["symmetry"] = {
                "number": int(_ds_get(ds, "number")),
                "international": str(_ds_get(ds, "international")),
                "hall": str(_ds_get(ds, "hall")),
                "pointgroup": str(_ds_get(ds, "pointgroup")),
                "wyckoffs": [str(w) for w in _ds_get(ds, "wyckoffs")],
                "equivalent_atoms": [int(x) for x in _ds_get(ds, "equivalent_atoms")],
                "n_operations": len(_ds_get(ds, "rotations")),
                "crystal_system": _crystal_system(int(_ds_get(ds, "number"))),
                "symprec": symprec,
            }
        else:
            out["symmetry"] = None
    return out


def _crystal_system(n: int) -> str:
    for lim, name in (
        (2, "triclinic"),
        (15, "monoclinic"),
        (74, "orthorhombic"),
        (142, "tetragonal"),
        (167, "trigonal"),
        (194, "hexagonal"),
        (230, "cubic"),
    ):
        if n <= lim:
            return name
    return "unknown"


def _from_spg(cell, frac, nums, labels, species, name=None) -> Structure:
    cell = np.array(cell)
    sites = [
        {"species": labels[n - 1], "xyz": (np.array(f) @ cell).tolist(), "fixed": [False] * 3}
        for f, n in zip(frac, nums)
    ]
    out = normalize({"cell": cell.tolist(), "pbc": [True] * 3, "sites": sites, "species": species})
    if name:
        out["name"] = name
    return out


# ----------------------------------------------------------------------------- transforms
def transform(s: Structure, op: str, p: dict[str, Any]) -> Structure:
    spglib = _spglib()

    s = normalize(s)
    name = s.get("name")
    if op in ("primitive", "conventional", "niggli"):
        spg, labels = _spg_cell(s)
        symprec = float(p.get("symprec", 1e-3))
        if op == "niggli":
            lat = _spg_call(spglib.niggli_reduce, spg[0], eps=symprec)
            if lat is None:
                raise StructureError("Niggli reduction failed")
            frac = (np.array([x["xyz"] for x in s["sites"]]) @ np.linalg.inv(lat)) % 1.0
            return _from_spg(lat, frac, spg[2], labels, s["species"], name)
        res = _spg_call(
            spglib.standardize_cell,
            spg,
            to_primitive=(op == "primitive"),
            no_idealize=not p.get("idealize", True),
            symprec=symprec,
        )
        if res is None:
            raise StructureError("symmetry search failed; try a larger tolerance")
        return _from_spg(res[0], res[1], res[2], labels, s["species"], name)

    atoms = to_atoms(s)
    if op == "supercell":
        m = p.get("matrix")
        if m is None:
            reps = [int(x) for x in p.get("repeat", [1, 1, 1])]
            if any(r < 1 for r in reps):
                raise StructureError("repeat factors must be >= 1")
            atoms = atoms.repeat(reps)
        else:
            from ase.build import make_supercell

            P = np.array(m, dtype=int).reshape(3, 3)
            if round(abs(np.linalg.det(P))) < 1:
                raise StructureError("supercell matrix must have non-zero determinant")
            atoms = make_supercell(atoms, P, wrap=True)
    elif op == "slab":
        from ase.build import surface

        hkl = tuple(int(x) for x in p.get("miller", [0, 0, 1]))
        layers = int(p.get("layers", 3))
        vac = float(p.get("vacuum", 10.0))
        atoms = surface(atoms, hkl, layers, vacuum=vac / 2.0, periodic=True)
        atoms.pbc = [True, True, True]
    elif op == "strain":
        eps = np.array(p.get("strain", [0, 0, 0, 0, 0, 0]), dtype=float)  # Voigt, fractional
        if eps.size == 1:
            eps = np.array([eps.item()] * 3 + [0, 0, 0])
        if eps.size == 3:
            eps = np.concatenate([eps, [0, 0, 0]])
        e = np.array(
            [[eps[0], eps[5] / 2, eps[4] / 2], [eps[5] / 2, eps[1], eps[3] / 2], [eps[4] / 2, eps[3] / 2, eps[2]]]
        )
        atoms.set_cell(atoms.cell[:] @ (np.eye(3) + e), scale_atoms=True)
    elif op == "scale_volume":
        f = float(p.get("factor", 1.0))
        if f <= 0:
            raise StructureError("volume factor must be positive")
        atoms.set_cell(atoms.cell[:] * f ** (1 / 3), scale_atoms=True)
    elif op == "set_cell":
        atoms.set_cell(np.array(p["cell"], dtype=float), scale_atoms=bool(p.get("scale_atoms", True)))
    elif op == "vacuum":
        axis = p.get("axis", 2)
        atoms.center(vacuum=float(p.get("vacuum", 10.0)) / 2.0, axis=axis)
    elif op == "wrap":
        atoms.wrap()
    elif op == "center":
        atoms.center()
    elif op == "rattle":
        atoms.rattle(stdev=float(p.get("stdev", 0.02)), seed=int(p.get("seed", 42)))
    elif op == "sort":
        order = np.argsort([a.symbol for a in atoms], kind="stable")
        atoms = atoms[order]
    elif op == "delete":
        idx = sorted({int(i) for i in p.get("indices", [])}, reverse=True)
        for i in idx:
            if not 0 <= i < len(atoms):
                raise StructureError(f"atom index {i} out of range")
            del atoms[i]
    elif op == "substitute":
        new_label = str(p["species"])
        el = label_to_element(new_label)
        out = from_atoms(atoms, name)
        for i in p.get("indices", []):
            out["sites"][int(i)]["species"] = new_label
        out["species"].setdefault(new_label, {"element": el})
        return normalize(out)
    elif op == "add":
        out = from_atoms(atoms, name)
        label = str(p["species"])
        xyz = np.array(p.get("xyz") if p.get("xyz") is not None else np.array(p["frac"]) @ np.array(out["cell"]))
        out["sites"].append({"species": label, "xyz": xyz.tolist(), "fixed": [False] * 3})
        out["species"].setdefault(label, {"element": label_to_element(label)})
        return normalize(out)
    elif op == "fix":
        out = from_atoms(atoms, name)
        mask = [bool(x) for x in p.get("mask", [True, True, True])]
        for i in p.get("indices", []):
            out["sites"][int(i)]["fixed"] = mask
        return out
    else:
        raise StructureError(f"unknown transform '{op}'")
    return from_atoms(atoms, name)


# ----------------------------------------------------------------------------- builders
def build(kind: str, p: dict[str, Any]) -> Structure:
    from ase import build as B

    try:
        if kind == "bulk":
            kw = {
                k: p[k]
                for k in ("a", "b", "c", "alpha", "covera", "u", "orthorhombic", "cubic")
                if p.get(k) not in (None, "")
            }
            atoms = B.bulk(p["formula"], p.get("crystalstructure") or None, **kw)
            name = f"{p['formula']}-{p.get('crystalstructure') or 'bulk'}"
        elif kind == "spacegroup":
            from ase.spacegroup import crystal

            atoms = crystal(
                symbols=p["symbols"],
                basis=p["basis"],
                spacegroup=int(p["spacegroup"]),
                cellpar=p["cellpar"],
                setting=int(p.get("setting", 1)),
            )
            name = "".join(p["symbols"]) + f"-sg{p['spacegroup']}"
        elif kind == "graphene":
            atoms = B.graphene(
                formula=p.get("formula", "C2"),
                a=float(p.get("a", 2.46)),
                thickness=float(p.get("thickness", 0.0)),
                vacuum=float(p.get("vacuum", 15.0)) / 2,
            )
            atoms.pbc = [True, True, True]
            name = p.get("formula", "graphene")
        elif kind == "mx2":
            atoms = B.mx2(
                formula=p.get("formula", "MoS2"),
                kind=p.get("kind", "2H"),
                a=float(p.get("a", 3.18)),
                thickness=float(p.get("thickness", 3.19)),
                vacuum=float(p.get("vacuum", 15.0)) / 2,
            )
            atoms.pbc = [True, True, True]
            name = p.get("formula", "MoS2")
        elif kind == "nanotube":
            atoms = B.nanotube(
                int(p.get("n", 6)),
                int(p.get("m", 0)),
                length=int(p.get("length", 1)),
                bond=float(p.get("bond", 1.42)),
                symbol=p.get("symbol", "C"),
                vacuum=float(p.get("vacuum", 10.0)) / 2,
            )
            atoms.pbc = [True, True, True]
            name = f"CNT({p.get('n', 6)},{p.get('m', 0)})"
        elif kind == "molecule":
            atoms = B.molecule(p["name"])
            atoms.center(vacuum=float(p.get("vacuum", 6.0)))
            atoms.pbc = [True, True, True]
            name = p["name"]
        else:
            raise StructureError(f"unknown builder '{kind}'")
    except StructureError:
        raise
    except Exception as exc:
        raise StructureError(f"build failed: {exc}") from exc
    return from_atoms(atoms, name=p.get("name") or name)


# ----------------------------------------------------------------------------- k-points

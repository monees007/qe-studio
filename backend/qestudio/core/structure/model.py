"""Structure model: the JSON structure format, conversions to/from ASE, basic geometry."""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np
from ase import Atoms
from ase.data import atomic_masses, atomic_numbers, covalent_radii

Structure = dict[str, Any]


class StructureError(ValueError):
    pass


# ----------------------------------------------------------------------------- helpers
def label_to_element(label: str) -> str:
    """QE convention: species label starts with the element symbol (Fe1, Fe_up, O2-)."""
    m = re.match(r"^([A-Za-z]{1,2})", label.strip())
    if m:
        letters = m.group(1)
        pair = letters[0].upper() + letters[1:].lower()
        single = letters[0].upper()
        if len(letters) == 2 and (letters[1].islower() or letters.isupper()) and pair in atomic_numbers:
            return pair
        if single in atomic_numbers and single != "X":
            return single
        if pair in atomic_numbers and pair != "X":
            return pair
    raise StructureError(f"cannot determine element from species label '{label}'")


def default_mass(element: str) -> float:
    z = atomic_numbers.get(element)
    if z is None:
        raise StructureError(f"unknown element '{element}'")
    return float(round(atomic_masses[z], 4))


def normalize(s: Structure) -> Structure:
    """Validate and fill defaults; returns a new dict."""
    try:
        cell = np.array(s.get("cell"), dtype=float).reshape(3, 3)
    except Exception as exc:
        raise StructureError(f"invalid cell: {exc}") from exc
    pbc = [bool(x) for x in (s.get("pbc") or [True, True, True])]
    sites_in = s.get("sites") or []
    species: dict[str, dict[str, Any]] = {k: dict(v) for k, v in (s.get("species") or {}).items()}
    sites = []
    for i, site in enumerate(sites_in):
        label = str(site.get("species") or site.get("element") or "").strip()
        if not label:
            raise StructureError(f"site {i + 1} has no species")
        xyz = [float(x) for x in site.get("xyz")]
        if len(xyz) != 3 or not all(math.isfinite(x) for x in xyz):
            raise StructureError(f"site {i + 1} has invalid coordinates")
        fixed = [bool(x) for x in (site.get("fixed") or [False, False, False])]
        sites.append({"species": label, "xyz": xyz, "fixed": fixed})
        if label not in species:
            species[label] = {}
    for label, sp in species.items():
        el = sp.get("element") or label_to_element(label)
        if el not in atomic_numbers:
            raise StructureError(f"unknown element '{el}' for species '{label}'")
        sp["element"] = el
        sp["mass"] = float(sp["mass"]) if sp.get("mass") else default_mass(el)
        sp.setdefault("pseudo", None)
        sp.setdefault("magnetization", None)
        sp.setdefault("hubbard_u", None)
    used = {x["species"] for x in sites}
    species = {k: v for k, v in species.items() if k in used}
    if any(pbc) and abs(np.linalg.det(cell)) < 1e-8:
        raise StructureError("cell is singular (zero volume)")
    out = {"cell": cell.tolist(), "pbc": pbc, "sites": sites, "species": species}
    if s.get("name"):
        out["name"] = s["name"]
    return out


def species_order(s: Structure) -> list[str]:
    seen: list[str] = []
    for site in s["sites"]:
        if site["species"] not in seen:
            seen.append(site["species"])
    return seen


def to_atoms(s: Structure) -> Atoms:
    s = normalize(s)
    labels = species_order(s)
    symbols = [s["species"][x["species"]]["element"] for x in s["sites"]]
    atoms = Atoms(symbols=symbols, positions=[x["xyz"] for x in s["sites"]], cell=s["cell"], pbc=s["pbc"])
    atoms.set_tags([labels.index(x["species"]) for x in s["sites"]])
    atoms.new_array("qes_fixed", np.array([x["fixed"] for x in s["sites"]], dtype=bool).reshape(-1, 3))
    atoms.info["qes_labels"] = labels
    atoms.info["qes_species"] = s["species"]
    return atoms


def from_atoms(atoms: Atoms, name: str | None = None) -> Structure:
    labels: list[str] | None = atoms.info.get("qes_labels")
    sp_info: dict[str, dict] = atoms.info.get("qes_species") or {}
    symbols = atoms.get_chemical_symbols()
    tags = atoms.get_tags()
    sites = []
    fixed = atoms.arrays.get("qes_fixed")
    if fixed is None:
        fixed = np.zeros((len(atoms), 3), dtype=bool)
        for c in atoms.constraints:
            cname = type(c).__name__
            if cname == "FixAtoms":
                fixed[c.index] = True
            elif cname == "FixCartesian":
                fixed[c.index] = np.logical_or(fixed[c.index], c.mask)
    magmoms = atoms.get_initial_magnetic_moments() if atoms.has("initial_magmoms") else None
    species: dict[str, dict[str, Any]] = {}
    for i, sym in enumerate(symbols):
        if labels and 0 <= tags[i] < len(labels) and label_to_element(labels[tags[i]]) == sym:
            label = labels[tags[i]]
        else:
            label = sym
        if label not in species:
            base = dict(sp_info.get(label) or {})
            base["element"] = sym
            if magmoms is not None and base.get("magnetization") is None and abs(magmoms[i]) > 1e-8:
                base["magnetization"] = float(np.clip(magmoms[i] / 5.0, -1, 1))
            species[label] = base
        sites.append(
            {"species": label, "xyz": [float(v) for v in atoms.positions[i]], "fixed": [bool(v) for v in fixed[i]]}
        )
    pbc = [bool(x) for x in atoms.pbc]
    cell = atoms.cell[:].tolist()
    if not any(pbc) and abs(np.linalg.det(atoms.cell[:])) < 1e-8:
        # molecule without a cell: put it in a box with 6 A vacuum
        a = atoms.copy()
        a.center(vacuum=6.0)
        cell = a.cell[:].tolist()
        for i, site in enumerate(sites):
            site["xyz"] = [float(v) for v in a.positions[i]]
    out = normalize({"cell": cell, "pbc": pbc, "sites": sites, "species": species})
    if name:
        out["name"] = name
    return out


def formula(s: Structure, reduced: bool = False) -> str:
    atoms = to_atoms(s)
    return atoms.get_chemical_formula(mode="metal", empirical=reduced)


def lattice_params(cell: np.ndarray) -> dict[str, float]:
    a, b, c = (float(np.linalg.norm(v)) for v in cell)

    def ang(u, v):
        return float(np.degrees(np.arccos(np.clip(np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v)), -1, 1))))

    return {
        "a": a,
        "b": b,
        "c": c,
        "alpha": ang(cell[1], cell[2]),
        "beta": ang(cell[0], cell[2]),
        "gamma": ang(cell[0], cell[1]),
        "volume": float(abs(np.linalg.det(cell))),
    }


def reciprocal(cell: np.ndarray) -> np.ndarray:
    return 2 * np.pi * np.linalg.inv(cell).T


def bonds(s: Structure, scale: float = 1.15, max_bonds: int = 20000) -> list[tuple[int, int, list[int]]]:
    """Bonds (i, j, image offset) using covalent radii; used by the viewer."""
    from ase.neighborlist import NeighborList

    atoms = to_atoms(s)
    if len(atoms) == 0:
        return []
    radii = [covalent_radii[a.number] * scale for a in atoms]
    nl = NeighborList(radii, self_interaction=False, bothways=False, skin=0.0)
    nl.update(atoms)
    out = []
    for i in range(len(atoms)):
        idx, offs = nl.get_neighbors(i)
        for j, o in zip(idx, offs):
            out.append((int(i), int(j), [int(x) for x in o]))
            if len(out) >= max_bonds:
                return out
    return out

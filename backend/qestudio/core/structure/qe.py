"""Quantum ESPRESSO input <-> structure: ibrav cells, reading and writing pw.x structure cards."""

from __future__ import annotations

import math
import re
from typing import Any

import numpy as np

from ..namelist import Card, QEInput
from ..units import BOHR_A
from .model import (
    Structure,
    StructureError,
    label_to_element,
    normalize,
    species_order,
)


# ----------------------------------------------------------------------------- QE ibrav
def ibrav_to_cell(system: dict[str, Any]) -> tuple[float, np.ndarray]:
    """Return (alat [Angstrom], cell [Angstrom]) following QE Modules/latgen.f90."""
    low = {k.lower().replace(" ", ""): v for k, v in system.items()}
    ibrav = int(low.get("ibrav", 0))
    cd = [0.0] * 7
    if "celldm(1)" in low:
        for i in range(1, 7):
            cd[i] = float(low.get(f"celldm({i})", 0.0) or 0.0)
        alat = cd[1] * BOHR_A
    elif "a" in low:
        a = float(low["a"])
        b = float(low.get("b", 0.0) or 0.0)
        c = float(low.get("c", 0.0) or 0.0)
        cosab = float(low.get("cosab", 0.0) or 0.0)
        cosac = float(low.get("cosac", 0.0) or 0.0)
        cosbc = float(low.get("cosbc", 0.0) or 0.0)
        alat = a
        cd[1] = a / BOHR_A
        cd[2] = b / a if b else 0.0
        cd[3] = c / a if c else 0.0
        if ibrav in (14, 0):
            cd[4], cd[5], cd[6] = cosbc, cosac, cosab
        elif ibrav in (-12, -13):
            cd[5] = cosac
        else:
            cd[4] = cosab
    else:
        raise StructureError("ibrav != 0 requires celldm(1) or A")
    if alat <= 0:
        raise StructureError("lattice parameter must be positive")
    a = 1.0
    b_a, c_a = cd[2], cd[3]
    s3 = math.sqrt(3.0)
    if ibrav == 1:
        v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    elif ibrav == 2:
        v = [[-0.5, 0, 0.5], [0, 0.5, 0.5], [-0.5, 0.5, 0]]
    elif ibrav == 3:
        v = [[0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5]]
    elif ibrav == -3:
        v = [[-0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5]]
    elif ibrav == 4:
        v = [[1, 0, 0], [-0.5, s3 / 2, 0], [0, 0, c_a]]
    elif ibrav in (5, -5):
        c = cd[4]
        if c <= -0.5 or c >= 1.0:
            raise StructureError("ibrav=5: celldm(4)=cos(gamma) must be in (-0.5, 1)")
        tx = math.sqrt((1 - c) / 2)
        ty = math.sqrt((1 - c) / 6)
        tz = math.sqrt((1 + 2 * c) / 3)
        if ibrav == 5:
            v = [[tx, -ty, tz], [0, 2 * ty, tz], [-tx, -ty, tz]]
        else:
            ap = 1 / s3
            u = tz - 2 * math.sqrt(2) * ty
            w = tz + math.sqrt(2) * ty
            v = [[ap * u, ap * w, ap * w], [ap * w, ap * u, ap * w], [ap * w, ap * w, ap * u]]
    elif ibrav == 6:
        v = [[1, 0, 0], [0, 1, 0], [0, 0, c_a]]
    elif ibrav == 7:
        v = [[0.5, -0.5, c_a / 2], [0.5, 0.5, c_a / 2], [-0.5, -0.5, c_a / 2]]
    elif ibrav == 8:
        v = [[1, 0, 0], [0, b_a, 0], [0, 0, c_a]]
    elif ibrav == 9:
        v = [[0.5, b_a / 2, 0], [-0.5, b_a / 2, 0], [0, 0, c_a]]
    elif ibrav == -9:
        v = [[0.5, -b_a / 2, 0], [0.5, b_a / 2, 0], [0, 0, c_a]]
    elif ibrav == 91:
        v = [[1, 0, 0], [0, b_a / 2, -c_a / 2], [0, b_a / 2, c_a / 2]]
    elif ibrav == 10:
        v = [[0.5, 0, c_a / 2], [0.5, b_a / 2, 0], [0, b_a / 2, c_a / 2]]
    elif ibrav == 11:
        v = [[0.5, b_a / 2, c_a / 2], [-0.5, b_a / 2, c_a / 2], [-0.5, -b_a / 2, c_a / 2]]
    elif ibrav == 12:
        g = cd[4]
        sg = math.sqrt(1 - g * g)
        v = [[1, 0, 0], [b_a * g, b_a * sg, 0], [0, 0, c_a]]
    elif ibrav == -12:
        bt = cd[5]
        sb = math.sqrt(1 - bt * bt)
        v = [[1, 0, 0], [0, b_a, 0], [c_a * bt, 0, c_a * sb]]
    elif ibrav == 13:
        g = cd[4]
        sg = math.sqrt(1 - g * g)
        v = [[0.5, 0, -c_a / 2], [b_a * g, b_a * sg, 0], [0.5, 0, c_a / 2]]
    elif ibrav == -13:
        bt = cd[5]
        sb = math.sqrt(1 - bt * bt)
        v = [[0.5, b_a / 2, 0], [-0.5, b_a / 2, 0], [c_a * bt, 0, c_a * sb]]
    elif ibrav == 14:
        ca, cb, cg = cd[4], cd[5], cd[6]
        sg = math.sqrt(1 - cg * cg)
        term = 1 + 2 * ca * cb * cg - ca * ca - cb * cb - cg * cg
        if term <= 0:
            raise StructureError("ibrav=14: inconsistent angles")
        v = [[1, 0, 0], [b_a * cg, b_a * sg, 0], [c_a * cb, c_a * (ca - cb * cg) / sg, c_a * math.sqrt(term) / sg]]
    else:
        raise StructureError(f"unsupported ibrav={ibrav}")
    cell = np.array(v, dtype=float) * a * alat
    if ibrav in (4, 6, 7, 8, 9, -9, 91, 10, 11, 12, -12, 13, -13, 14) and (
        (ibrav not in (4, 6, 7) and b_a <= 0) or c_a <= 0
    ):
        raise StructureError(f"ibrav={ibrav} requires celldm(2)/celldm(3) (or B, C)")
    return alat, cell


# ----------------------------------------------------------------------------- QE <-> structure
def _floats(tokens: list[str]) -> list[float]:
    return [float(t.replace("d", "e").replace("D", "e")) for t in tokens]


def from_pw_input(qi: QEInput) -> Structure:
    sysnl = qi.nl("SYSTEM")
    if not sysnl:
        raise StructureError("&SYSTEM namelist missing")
    ibrav = int(qi.get("SYSTEM", "ibrav", 0))
    alat: float | None = None
    if qi.get("SYSTEM", "celldm(1)") is not None:
        alat = float(qi.get("SYSTEM", "celldm(1)")) * BOHR_A
    elif qi.get("SYSTEM", "A") is not None:
        alat = float(qi.get("SYSTEM", "A"))
    if ibrav == 0:
        cp = qi.card("CELL_PARAMETERS")
        if cp is None:
            raise StructureError("ibrav=0 requires a CELL_PARAMETERS card")
        rows = [_floats(ln.split()[:3]) for ln in cp.lines[:3]]
        if len(rows) != 3 or any(len(r) != 3 for r in rows):
            raise StructureError("CELL_PARAMETERS needs three lines of three numbers")
        cell = np.array(rows)
        opt = (cp.option or ("alat" if alat else "bohr")).lower()
        if opt == "bohr":
            cell = cell * BOHR_A
        elif opt == "alat":
            if alat is None:
                raise StructureError("CELL_PARAMETERS alat requires celldm(1) or A")
            cell = cell * alat
        elif opt != "angstrom":
            raise StructureError(f"unsupported CELL_PARAMETERS units '{opt}'")
        if alat is None:
            alat = float(np.linalg.norm(cell[0]))
    else:
        alat, cell = ibrav_to_cell(sysnl)

    # species
    species: dict[str, dict[str, Any]] = {}
    labels: list[str] = []
    sp_card = qi.card("ATOMIC_SPECIES")
    if sp_card is None:
        raise StructureError("ATOMIC_SPECIES card missing")
    for ln in sp_card.lines:
        tok = ln.split()
        if len(tok) < 3:
            raise StructureError(f"ATOMIC_SPECIES line needs 'label mass pseudo': '{ln}'")
        label = tok[0]
        try:
            mass = float(tok[1].replace("d", "e").replace("D", "e"))
        except ValueError as exc:
            raise StructureError(f"invalid mass in ATOMIC_SPECIES: '{ln}'") from exc
        labels.append(label)
        species[label] = {"element": label_to_element(label), "mass": mass if mass > 0 else None, "pseudo": tok[2]}
    for idx_s, v in qi.indexed("SYSTEM", "starting_magnetization").items():
        try:
            k = int(idx_s) - 1
            species[labels[k]]["magnetization"] = float(v)
        except (ValueError, IndexError):
            pass

    pos = qi.card("ATOMIC_POSITIONS")
    if pos is None:
        raise StructureError("ATOMIC_POSITIONS card missing")
    unit = (pos.option or "alat").lower()
    nat = int(qi.get("SYSTEM", "nat", len(pos.lines)))
    sites = []
    for ln in pos.lines[:nat]:
        tok = ln.split()
        if len(tok) < 4:
            raise StructureError(f"ATOMIC_POSITIONS line needs 'label x y z': '{ln}'")
        label = tok[0]
        if label not in species:
            raise StructureError(f"species '{label}' used in ATOMIC_POSITIONS is not in ATOMIC_SPECIES")
        xyz = np.array(_floats(tok[1:4]))
        if unit == "crystal":
            xyz = xyz @ cell
        elif unit == "alat":
            if alat is None:
                raise StructureError("positions in alat units need celldm(1) or A")
            xyz = xyz * alat
        elif unit == "bohr":
            xyz = xyz * BOHR_A
        elif unit == "angstrom":
            pass
        elif unit == "crystal_sg":
            raise StructureError("crystal_sg positions (space_group input) are not supported; convert to ibrav=0 first")
        else:
            raise StructureError(f"unknown ATOMIC_POSITIONS units '{unit}'")
        fixed = [False, False, False]
        if len(tok) >= 7:
            try:
                fixed = [int(t) == 0 for t in tok[4:7]]
            except ValueError:
                pass
        sites.append({"species": label, "xyz": xyz.tolist(), "fixed": fixed})
    if len(sites) != nat:
        raise StructureError(f"nat={nat} but {len(sites)} positions given")
    assume = str(qi.get("SYSTEM", "assume_isolated", "none")).lower()
    pbc = [True, True, True]
    if assume in ("2d",):
        pbc = [True, True, False]
    return normalize({"cell": cell.tolist(), "pbc": pbc, "sites": sites, "species": species})


_CELL_KEYS = re.compile(r"^(celldm\(\d\)|a|b|c|cosab|cosac|cosbc)$", re.I)


def fmt_num(x: float, digits: int = 10) -> str:
    s = f"{x:.{digits}f}"
    if "." in s:
        s = s.rstrip("0")
        if s.endswith("."):
            s += "0"
    if s in ("-0.0",):
        s = "0.0"
    return s


def apply_to_pw_input(
    qi: QEInput,
    s: Structure,
    pseudo_map: dict[str, str] | None = None,
    cell_units: str = "angstrom",
    position_units: str = "crystal",
) -> QEInput:
    """Write structure into a pw.x input (ibrav=0). Keeps every other parameter."""
    s = normalize(s)
    pseudo_map = pseudo_map or {}
    sysnl = qi.nl("SYSTEM", create=True)
    for k in list(sysnl):
        if _CELL_KEYS.match(k) or k.lower().startswith("starting_magnetization("):
            del sysnl[k]
    labels = species_order(s)
    qi.set("SYSTEM", "ibrav", 0)
    qi.set("SYSTEM", "nat", len(s["sites"]))
    qi.set("SYSTEM", "ntyp", len(labels))
    for i, lab in enumerate(labels):
        m = s["species"][lab].get("magnetization")
        if m not in (None, 0, 0.0):
            qi.set("SYSTEM", f"starting_magnetization({i + 1})", float(m))
    cell = np.array(s["cell"])
    qi.set_card(Card("CELL_PARAMETERS", "angstrom", ["  ".join(fmt_num(x) for x in row) for row in cell]))
    lines = []
    for lab in labels:
        sp = s["species"][lab]
        pseudo = sp.get("pseudo") or pseudo_map.get(lab) or pseudo_map.get(sp["element"]) or f"{sp['element']}.upf"
        lines.append(f"{lab}  {fmt_num(sp['mass'], 4)}  {pseudo}")
    qi.set_card(Card("ATOMIC_SPECIES", None, lines))
    frac = np.array([x["xyz"] for x in s["sites"]]) @ np.linalg.inv(cell) if s["sites"] else np.zeros((0, 3))
    any_fixed = any(any(x["fixed"]) for x in s["sites"])
    plines = []
    for i, site in enumerate(s["sites"]):
        coords = frac[i] if position_units == "crystal" else np.array(site["xyz"])
        ln = f"{site['species']:<4} " + "  ".join(f"{fmt_num(float(c)):>14}" for c in coords)
        if any_fixed:
            ln += "  " + " ".join("0" if f else "1" for f in site["fixed"])
        plines.append(ln)
    qi.set_card(Card("ATOMIC_POSITIONS", position_units, plines))
    # keep canonical card order
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
    return qi

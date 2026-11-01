"""Reading and writing structure files (CIF, POSCAR, XYZ, QE input/output, ... via ASE)."""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from ase import Atoms

from ..namelist import Card
from .kpoints import kmesh
from .model import (
    Structure,
    StructureError,
    from_atoms,
    normalize,
    to_atoms,
)
from .qe import apply_to_pw_input, from_pw_input

# ----------------------------------------------------------------------------- IO
READ_FORMATS = {
    ".cif": "cif",
    ".mcif": "cif",
    ".vasp": "vasp",
    ".poscar": "vasp",
    ".contcar": "vasp",
    ".xyz": "extxyz",
    ".extxyz": "extxyz",
    ".xsf": "xsf",
    ".pdb": "proteindatabank",
    ".json": "json",
    ".traj": "traj",
    ".cube": "cube",
    ".gen": "gen",
    ".res": "res",
    ".in": None,
    ".pwi": None,
    ".out": None,
    ".pwo": None,
}
WRITE_FORMATS = {
    "cif": ("cif", ".cif"),
    "poscar": ("vasp", ".vasp"),
    "xyz": ("extxyz", ".xyz"),
    "xsf": ("xsf", ".xsf"),
    "pdb": ("proteindatabank", ".pdb"),
    "json": ("json", ".json"),
}


def _looks_like_pw_input(text: str) -> bool:
    return bool(re.search(r"^\s*&system", text, re.I | re.M)) and bool(re.search(r"ATOMIC_POSITIONS", text, re.I))


def _looks_like_pw_output(text: str) -> bool:
    return "Program PWSCF" in text[:20000] or "lattice parameter (alat)" in text[:50000]


def read_any(data: bytes, filename: str | None = None, fmt: str | None = None) -> list[Structure]:
    from ase.io import read

    from ..namelist import parse

    name = filename or "structure"
    text = None
    try:
        text = data.decode("utf-8", errors="replace")
    except Exception:
        text = None
    if fmt in (None, "", "auto", "pw-in") and text is not None and _looks_like_pw_input(text):
        qi = parse(text, "pw")
        return [from_pw_input(qi) | {"name": Path(name).stem}]
    suffix = Path(name).suffix.lower()
    base = Path(name).name.upper()
    ase_fmt = fmt if fmt not in (None, "", "auto") else READ_FORMATS.get(suffix)
    if ase_fmt is None and text is not None and _looks_like_pw_output(text):
        ase_fmt = "espresso-out"
    if ase_fmt is None and ("POSCAR" in base or "CONTCAR" in base):
        ase_fmt = "vasp"
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / (Path(name).name or "structure")
        p.write_bytes(data)
        try:
            frames = read(str(p), index=":", format=ase_fmt)
        except Exception as exc:
            raise StructureError(f"could not read structure ({ase_fmt or 'auto-detected format'}): {exc}") from exc
    if isinstance(frames, Atoms):
        frames = [frames]
    if not frames:
        raise StructureError("no structure found in file")
    out = []
    for i, a in enumerate(frames):
        st = from_atoms(a, name=Path(name).stem + (f"_{i + 1}" if len(frames) > 1 else ""))
        out.append(st)
    return out


def write_any(s: Structure, fmt: str) -> tuple[str, str]:
    """Return (text, suggested filename)."""
    from ase.io import write

    from ..namelist import QEInput, render

    s = normalize(s)
    name = s.get("name") or "structure"
    if fmt == "pw-in":
        qi = QEInput(program="pw")
        qi.set("CONTROL", "calculation", "scf")
        qi.set("SYSTEM", "ecutwfc", 40.0)
        apply_to_pw_input(qi, s)
        qi.set_card(Card("K_POINTS", "automatic", [" ".join(map(str, kmesh(s, 0.25))) + " 0 0 0"]))
        return render(qi), f"{name}.pwi"
    if fmt == "qes-json":
        import json

        return json.dumps(s, indent=1), f"{name}.qes.json"
    if fmt not in WRITE_FORMATS:
        raise StructureError(f"unsupported export format '{fmt}'")
    ase_fmt, ext = WRITE_FORMATS[fmt]
    atoms = to_atoms(s)
    atoms.info.pop("qes_species", None)
    atoms.info.pop("qes_labels", None)
    del atoms.arrays["qes_fixed"]
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / f"out{ext}"
        if ase_fmt == "vasp":
            write(str(p), atoms, format="vasp", direct=True, sort=False)
        else:
            write(str(p), atoms, format=ase_fmt)
        return p.read_text(), f"{name}{ext}"

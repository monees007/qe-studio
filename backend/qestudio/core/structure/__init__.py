"""Crystal-structure model, conversions (ASE / QE input), symmetry, builders and k-points.

Structure JSON (shared with the frontend):
{
  "cell":  [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]   # Angstrom, rows are lattice vectors
  "pbc":   [true,true,true],
  "sites": [{"species": "Fe1", "xyz": [x,y,z], "fixed": [false,false,false]}],   # cartesian Angstrom
  "species": {"Fe1": {"element": "Fe", "mass": 55.845, "pseudo": "Fe.upf",
                      "magnetization": 0.5, "hubbard_u": null}}
}
Species labels allow distinct species of the same element (e.g. AFM sublattices).

Package layout:
  model.py     the structure dict, ASE conversion, basic geometry (lattice parameters, bonds)
  qe.py        QE input <-> structure (ibrav, CELL_PARAMETERS, ATOMIC_POSITIONS, ...)
  formats.py   file import/export through ASE (CIF, POSCAR, XYZ, QE files, ...)
  symmetry.py  spglib analysis, primitive/conventional/Niggli cells, supercells, slabs, builders
  kpoints.py   Monkhorst-Pack meshes and band paths

Import from the package (``from ..core import structure as ST``); the submodules are an
implementation detail.
"""

from ase.data import chemical_symbols

from .formats import read_any, write_any
from .kpoints import kmesh, kpath
from .model import (
    Structure,
    StructureError,
    bonds,
    formula,
    from_atoms,
    label_to_element,
    lattice_params,
    normalize,
    reciprocal,
    species_order,
    to_atoms,
)
from .qe import apply_to_pw_input, fmt_num, from_pw_input, ibrav_to_cell
from .symmetry import analyze, build, transform

__all__ = [
    "Structure",
    "StructureError",
    "analyze",
    "apply_to_pw_input",
    "bonds",
    "build",
    "chemical_symbols",
    "fmt_num",
    "formula",
    "from_atoms",
    "from_pw_input",
    "ibrav_to_cell",
    "kmesh",
    "kpath",
    "label_to_element",
    "lattice_params",
    "normalize",
    "read_any",
    "reciprocal",
    "species_order",
    "to_atoms",
    "transform",
    "write_any",
]

"""Parameter schema for QE programs.

pw/ph/pp/dos/projwfc/bands/hp/neb come from qe_schema.json, generated from the official
INPUT_*.def documentation shipped with QE (see tools/gen_schema.py). q2r.x and matdyn.x
are not covered there, so their most-used variables are described here by hand (from
PHonon/Doc/INPUT_Q2R / INPUT_MATDYN and the source headers).
"""

from __future__ import annotations

import json
from functools import lru_cache
from importlib import resources
from typing import Any


def _v(name, type_, desc, default=None, options=None, required=False, dimension=False):
    return {
        "name": name,
        "type": type_,
        "label": name,
        "default": default,
        "required": required,
        "status": "REQUIRED" if required else None,
        "options": options,
        "dimension": dimension,
        "description": desc,
    }


_MANUAL = {
    "q2r": {
        "namelists": {
            "INPUT": [
                _v(
                    "fildyn",
                    "character",
                    "Input file name (prefix of the dynamical-matrix files written by ph.x; "
                    "fildyn0 contains the q-grid).",
                    required=True,
                ),
                _v(
                    "flfrc",
                    "character",
                    "Output file containing the interatomic force constants in real space.",
                    required=True,
                ),
                _v(
                    "zasr",
                    "character",
                    "Acoustic sum rule imposed on effective charges.",
                    "'no'",
                    ["no", "simple", "crystal", "one-dim", "zero-dim"],
                ),
                _v("loto_2d", "logical", "Set to .true. to activate the 2D treatment of LO-TO splitting.", ".false."),
            ]
        }
    },
    "matdyn": {
        "namelists": {
            "INPUT": [
                _v(
                    "flfrc",
                    "character",
                    "File produced by q2r.x containing the force constants (needed).",
                    required=True,
                ),
                _v(
                    "asr",
                    "character",
                    "Acoustic sum rule imposed on the force constants.",
                    "'no'",
                    ["no", "simple", "crystal", "all", "one-dim", "zero-dim"],
                ),
                _v(
                    "dos",
                    "logical",
                    "If .true. calculate phonon DOS on a uniform nk1 x nk2 x nk3 grid, "
                    "otherwise frequencies on the q-points listed after the namelist.",
                    ".false.",
                ),
                _v("nk1", "integer", "Uniform q-grid for DOS (first direction).", "0"),
                _v("nk2", "integer", "Uniform q-grid for DOS (second direction).", "0"),
                _v("nk3", "integer", "Uniform q-grid for DOS (third direction).", "0"),
                _v("deltaE", "real", "Energy step (cm^-1) for the DOS.", "1.0"),
                _v("degauss", "real", "Gaussian broadening (cm^-1) for the DOS; 0 means tetrahedra.", "0"),
                _v("ndos", "integer", "Number of energy steps for the DOS (computed from deltaE if absent).", None),
                _v("fldos", "character", "Output file for the phonon DOS.", "'matdyn.dos'"),
                _v("flfrq", "character", "Output file for frequencies.", "'matdyn.freq'"),
                _v("flvec", "character", "Output file for normalized phonon displacements.", "'matdyn.modes'"),
                _v("fleig", "character", "Output file for phonon eigenvectors.", "'matdyn.eig'"),
                _v("fldyn", "character", "Output file for dynamical matrix (empty: not written).", "' '"),
                _v(
                    "q_in_band_form",
                    "logical",
                    "If .true. the q-points list gives path end-points and the number of points per segment.",
                    ".false.",
                ),
                _v("q_in_cryst_coord", "logical", "If .true. q-points are in crystal coordinates.", ".false."),
                _v(
                    "eigen_similarity",
                    "logical",
                    "Use similarity of eigenvectors to order bands along a path.",
                    ".false.",
                ),
                _v(
                    "amass",
                    "real",
                    "Masses of atoms in the supercell (a.m.u.), one per atom type.",
                    None,
                    dimension=True,
                ),
                _v("readtau", "logical", "Read atomic positions of the supercell from input.", ".false."),
                _v("fltau", "character", "Write atomic positions of the supercell to this file.", "' '"),
                _v("la2F", "logical", "If .true. interpolates also electron-phonon coefficients.", ".false."),
                _v("loto_2d", "logical", "2D treatment of LO-TO splitting.", ".false."),
                _v("loto_disable", "logical", "If .true. do not apply LO-TO splitting for q=0.", ".false."),
                _v(
                    "na_ifc", "logical", "Add non-analytic contributions to the interatomic force constants.", ".false."
                ),
                _v("fd", "logical", "If .true. the IFCs come from the finite-displacement method.", ".false."),
                _v("nosym", "logical", "If .true., no symmetry and no time reversal are imposed.", ".false."),
            ]
        }
    },
}


@lru_cache
def load_schema() -> dict[str, Any]:
    data = json.loads(resources.files("qestudio.data").joinpath("qe_schema.json").read_text())
    data.update(_MANUAL)
    return data


def program_schema(program: str) -> dict[str, Any]:
    return load_schema().get(program, {"namelists": {}})


@lru_cache
def var_index(program: str) -> dict[str, dict[str, dict[str, Any]]]:
    """{NAMELIST: {lower-case base name: var}}"""
    out: dict[str, dict[str, dict[str, Any]]] = {}
    for nl, vars_ in program_schema(program).get("namelists", {}).items():
        out[nl] = {v["name"].lower(): v for v in vars_}
    return out


@lru_cache
def all_vars(program: str) -> dict[str, tuple[str, dict[str, Any]]]:
    """lower-case name -> (namelist, var) across namelists."""
    out: dict[str, tuple[str, dict[str, Any]]] = {}
    for nl, d in var_index(program).items():
        for k, v in d.items():
            out.setdefault(k, (nl, v))
    return out


@lru_cache
def schema_order(program: str) -> dict[str, dict[str, int]]:
    return {
        nl: {v["name"].lower(): i for i, v in enumerate(vars_)}
        for nl, vars_ in program_schema(program).get("namelists", {}).items()
    }


def lookup(program: str, namelist: str, key: str) -> dict[str, Any] | None:
    base = key.split("(", maxsplit=1)[0].lower()
    return var_index(program).get(namelist.upper(), {}).get(base)

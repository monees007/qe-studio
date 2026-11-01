"""Preparing step inputs for submission (pure functions, no I/O)."""

from __future__ import annotations

import posixpath
import re
from typing import Any

from ..core.namelist import QEInputError, parse, render

#: executable -> parser program key
PROG_KEY = {
    "pw.x": "pw",
    "ph.x": "ph",
    "pp.x": "pp",
    "dos.x": "dos",
    "projwfc.x": "projwfc",
    "bands.x": "bands",
    "q2r.x": "q2r",
    "matdyn.x": "matdyn",
    "hp.x": "hp",
}
#: executable -> namelist that carries ``outdir``
OUTDIR_NAMELIST = {
    "pw.x": "CONTROL",
    "ph.x": "INPUTPH",
    "pp.x": "INPUTPP",
    "dos.x": "DOS",
    "projwfc.x": "PROJWFC",
    "bands.x": "BANDS",
    "hp.x": "INPUTHP",
}
#: every step of a job shares this scratch directory (relative to the step directory)
JOB_OUTDIR = "./tmp/"

_SAFE_REL_PATH = re.compile(r"^[A-Za-z0-9_.\-/]+$")


class JobError(ValueError):
    """A job cannot be created or submitted (message is shown to the user)."""


def slugify(text: str, max_len: int = 30) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", text).strip("-")[:max_len] or "job"


def relative_to_job_root(cwd: str) -> str:
    """'./' for the job directory itself, '../' per level for sub-directories."""
    depth = len([p for p in posixpath.normpath(cwd or ".").split("/") if p not in ("", ".")])
    return "./" if depth == 0 else "../" * depth


def check_relative_path(value: str, what: str) -> None:
    if not _SAFE_REL_PATH.match(value) or ".." in value.split("/") or value.startswith("/"):
        raise JobError(f"invalid {what} '{value}'")


def prepare_inputs(steps: list[dict[str, Any]], keep_paths: bool = False) -> tuple[list[dict[str, Any]], set[str]]:
    """Normalise steps and rewrite paths so every job directory is self-contained.

    * ``outdir`` of every QE program -> ``./tmp/`` (shared by all steps of one directory)
    * ``pseudo_dir`` of pw.x -> the job's ``pseudo/`` folder (relative to the step directory)

    Returns the new steps and the set of pseudopotential files referenced by pw.x steps.
    """
    pseudos: set[str] = set()
    prepared = []
    for raw in steps:
        step = dict(raw)
        step.setdefault("cwd", ".")
        step.setdefault("output_name", step["input_name"].rsplit(".", 1)[0] + ".out")
        check_relative_path(step["input_name"], "input file name")
        check_relative_path(step["output_name"], "output file name")
        check_relative_path(step["cwd"], "step directory")
        program = step.get("program", "")
        key = PROG_KEY.get(program)
        if key:
            label = step.get("label") or program
            try:
                qi = parse(step["input"], key)
            except QEInputError as exc:
                raise JobError(f"step '{label}': {exc}") from exc
            changed = False
            namelist = OUTDIR_NAMELIST.get(program)
            if namelist and not keep_paths and qi.get(namelist, "outdir") != JOB_OUTDIR:
                qi.set(namelist, "outdir", JOB_OUTDIR)
                changed = True
            if program == "pw.x":
                want = relative_to_job_root(step["cwd"]) + "pseudo/"
                if not keep_paths and qi.get("CONTROL", "pseudo_dir") != want:
                    qi.set("CONTROL", "pseudo_dir", want)
                    changed = True
                species = qi.card("ATOMIC_SPECIES")
                if species is None:
                    raise JobError(f"step '{label}': ATOMIC_SPECIES missing")
                for line in species.lines:
                    tokens = line.split()
                    if len(tokens) >= 3:
                        pseudos.add(tokens[2])
            if changed:
                step["input"] = render(qi)
        prepared.append(step)
    return prepared, pseudos

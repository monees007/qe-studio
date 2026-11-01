"""Stand-alone analysis: uploaded outputs, isosurfaces, EOS fits."""

from __future__ import annotations

import asyncio
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel, Field

from ..analysis import parse_uploaded, sanitize
from ..core.parsers import post as P
from ..core.units import EV_PER_A3_TO_GPA
from ..jobs.manager import manager
from .common import bad, not_found, read_upload

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


@router.post("/parse")
async def parse(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await read_upload(file, 500 * 1024 * 1024)
    try:
        return await asyncio.to_thread(
            parse_uploaded, file.filename or "output", data.decode("utf-8", errors="replace")
        )
    except ValueError as exc:
        raise bad(str(exc)) from exc


@lru_cache(maxsize=4)
def _load_cube(path: str, mtime: float) -> dict[str, Any]:
    return P.parse_cube(Path(path).read_text())


class IsoIn(BaseModel):
    job_id: str
    file: str
    level: float
    both_signs: bool = False


@router.post("/isosurface")
async def isosurface(body: IsoIn) -> dict[str, Any]:
    d = manager.local_dir(body.job_id)
    p = (d / body.file).resolve()
    if not str(p).startswith(str(d.resolve())) or not p.is_file():
        raise not_found("cube file")

    def work() -> dict[str, Any]:
        cube = _load_cube(str(p), p.stat().st_mtime)
        out = {
            "positive": P.isosurface(cube, abs(body.level)),
            "cell": cube["cell"].tolist(),
            "origin": cube["origin"].tolist(),
            "atoms": cube["atoms"],
            "stats": cube["stats"],
        }
        if body.both_signs:
            out["negative"] = P.isosurface(cube, -abs(body.level))
        return out

    try:
        return sanitize(await asyncio.to_thread(work))
    except ValueError as exc:
        raise bad(str(exc)) from exc


class EOSIn(BaseModel):
    volumes: list[float] = Field(..., min_length=5)
    energies: list[float] = Field(..., min_length=5)
    eos: str = "birchmurnaghan"


@router.post("/eos")
async def eos_fit(body: EOSIn) -> dict[str, Any]:
    import numpy as np
    from ase.eos import EquationOfState

    if len(body.volumes) != len(body.energies):
        raise bad("volumes and energies must have the same length")
    try:
        e = EquationOfState(body.volumes, body.energies, eos=body.eos)
        v0, e0, B = e.fit()
        vf = np.linspace(min(body.volumes), max(body.volumes), 120)
        ef = e.func(vf, *e.eos_parameters)
        return sanitize(
            {
                "v0": v0,
                "e0": e0,
                "B0_GPa": B * EV_PER_A3_TO_GPA,
                "B0_prime": float(e.eos_parameters[2]) if len(e.eos_parameters) > 2 else None,
                "curve": {"volume": vf, "energy": ef},
            }
        )
    except Exception as exc:
        raise bad(f"fit failed: {exc}") from exc

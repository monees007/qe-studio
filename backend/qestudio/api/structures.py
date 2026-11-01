"""Structure library, IO, symmetry, transformations, builders and k-points."""

from __future__ import annotations

import asyncio
import re
from typing import Any, Literal

import httpx
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..core import structure as ST
from ..db import StructureRow, session
from .common import bad, not_found, read_upload

router = APIRouter(prefix="/api/structures", tags=["structures"])


class StructureIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    structure: dict[str, Any]
    source: str = ""


def _row(r: StructureRow, full: bool = True) -> dict[str, Any]:
    d = {
        "id": r.id,
        "name": r.name,
        "formula": r.formula,
        "natoms": r.natoms,
        "source": r.source,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    }
    if full:
        d["structure"] = r.data
    else:
        d["spacegroup"] = (r.data or {}).get("_spacegroup")
    return d


def _norm(s: dict[str, Any]) -> dict[str, Any]:
    try:
        return ST.normalize(s)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc


@router.get("")
async def list_structures() -> list[dict[str, Any]]:
    with session() as s:
        return [_row(r, full=False) for r in s.query(StructureRow).order_by(StructureRow.updated_at.desc()).all()]


@router.post("")
async def create_structure(body: StructureIn) -> dict[str, Any]:
    st = _norm(body.structure)
    try:
        info = ST.analyze(st)
        sg = (info.get("symmetry") or {}).get("international")
    except Exception:
        info, sg = {"formula": ""}, None
    st["_spacegroup"] = sg
    with session() as s:
        r = StructureRow(
            name=body.name, formula=info.get("formula", ""), natoms=len(st["sites"]), data=st, source=body.source
        )
        s.add(r)
        s.flush()
        return _row(r)


@router.get("/{sid}")
async def get_structure(sid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(StructureRow, sid)
        if r is None:
            raise not_found("structure")
        return _row(r)


@router.put("/{sid}")
async def update_structure(sid: str, body: StructureIn) -> dict[str, Any]:
    st = _norm(body.structure)
    try:
        info = ST.analyze(st)
        st["_spacegroup"] = (info.get("symmetry") or {}).get("international")
    except Exception:
        info = {"formula": ""}
    with session() as s:
        r = s.get(StructureRow, sid)
        if r is None:
            raise not_found("structure")
        r.name, r.data, r.formula, r.natoms = body.name, st, info.get("formula", ""), len(st["sites"])
        if body.source:
            r.source = body.source
        s.flush()
        return _row(r)


@router.delete("/{sid}")
async def delete_structure(sid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(StructureRow, sid)
        if r is None:
            raise not_found("structure")
        s.delete(r)
    return {"ok": True}


# ----------------------------------------------------------------------------- IO
@router.post("/parse")
async def parse_file(
    file: UploadFile | None = File(None),
    text: str | None = Form(None),
    filename: str | None = Form(None),
    fmt: str | None = Form(None),
) -> dict[str, Any]:
    if file is not None:
        data = await read_upload(file, 200 * 1024 * 1024)
        name = file.filename or filename or "structure"
    elif text is not None:
        data = text.encode()
        name = filename or "pasted.cif"
    else:
        raise bad("provide a file or text")
    try:
        frames = await asyncio.to_thread(ST.read_any, data, name, fmt)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc
    except Exception as exc:
        raise bad(f"could not parse '{name}': {exc}") from exc
    if len(frames) > 500:
        frames = frames[:: max(1, len(frames) // 500)]
    return {"structures": frames, "count": len(frames)}


class ExportIn(BaseModel):
    structure: dict[str, Any]
    format: Literal["cif", "poscar", "xyz", "xsf", "pdb", "json", "pw-in", "qes-json"]


@router.post("/export")
async def export(body: ExportIn) -> Response:
    try:
        text, fn = ST.write_any(body.structure, body.format)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc
    return Response(
        text, media_type="text/plain", headers={"Content-Disposition": f'attachment; filename="{fn}"', "X-Filename": fn}
    )


class AnalyzeIn(BaseModel):
    structure: dict[str, Any]
    symprec: float = Field(1e-3, gt=0, le=1)


@router.post("/analyze")
async def analyze(body: AnalyzeIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(ST.analyze, body.structure, body.symprec)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc


class TransformIn(BaseModel):
    structure: dict[str, Any]
    op: str
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/transform")
async def transform(body: TransformIn) -> dict[str, Any]:
    try:
        out = await asyncio.to_thread(ST.transform, body.structure, body.op, body.params)
    except (ST.StructureError, KeyError, ValueError, IndexError, TypeError) as exc:
        raise bad(f"{body.op}: {exc}") from exc
    if len(out["sites"]) > 20000:
        raise bad("resulting structure has more than 20000 atoms")
    return {"structure": out}


class BuildIn(BaseModel):
    kind: str
    params: dict[str, Any] = Field(default_factory=dict)


@router.post("/build")
async def build(body: BuildIn) -> dict[str, Any]:
    try:
        return {"structure": await asyncio.to_thread(ST.build, body.kind, body.params)}
    except (ST.StructureError, KeyError) as exc:
        raise bad(str(exc)) from exc


class KPathIn(BaseModel):
    structure: dict[str, Any]
    npoints: int = Field(100, ge=10, le=2000)
    path: str | None = None


@router.post("/kpath")
async def kpath(body: KPathIn) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(ST.kpath, body.structure, body.npoints, body.path or None)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc


class KMeshIn(BaseModel):
    structure: dict[str, Any]
    kspacing: float = Field(0.2, gt=0.005, le=5)


@router.post("/kmesh")
async def kmesh(body: KMeshIn) -> dict[str, Any]:
    try:
        st = ST.normalize(body.structure)
        mesh = ST.kmesh(st, body.kspacing)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc
    return {"mesh": mesh, "nk": mesh[0] * mesh[1] * mesh[2]}


class BondsIn(BaseModel):
    structure: dict[str, Any]
    scale: float = Field(1.15, gt=0.5, le=2.0)


@router.post("/bonds")
async def bonds(body: BondsIn) -> dict[str, Any]:
    try:
        b = await asyncio.to_thread(ST.bonds, body.structure, body.scale)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc
    return {"bonds": b}


class FetchIn(BaseModel):
    source: Literal["cod", "url"]
    id: str = Field(..., min_length=1, max_length=2000)


@router.post("/fetch")
async def fetch(body: FetchIn) -> dict[str, Any]:
    if body.source == "cod":
        if not re.fullmatch(r"\d{7}", body.id.strip()):
            raise bad("COD ids have 7 digits, e.g. 9008565")
        url = f"https://www.crystallography.net/cod/{body.id.strip()}.cif"
        name = f"COD-{body.id.strip()}.cif"
    else:
        url = body.id.strip()
        if not re.match(r"^https://", url):
            raise bad("only https:// URLs are allowed")
        name = url.rsplit("/", 1)[-1].split("?")[0] or "download.cif"
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True, trust_env=True) as cli:
            r = await cli.get(url)
    except httpx.HTTPError as exc:
        raise bad(f"download failed: {exc}") from exc
    if r.status_code != 200:
        raise bad(f"download failed: HTTP {r.status_code}")
    if len(r.content) > 50 * 1024 * 1024:
        raise bad("file too large")
    try:
        frames = await asyncio.to_thread(ST.read_any, r.content, name, None)
    except ST.StructureError as exc:
        raise bad(str(exc)) from exc
    return {"structures": frames, "source": url}

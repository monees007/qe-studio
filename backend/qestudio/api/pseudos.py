"""Pseudopotential library API."""

from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import pseudos as PS
from .. import tasks
from .common import bad, not_found, read_upload

router = APIRouter(prefix="/api/pseudos", tags=["pseudos"])

_MC = "https://archive.materialscloud.org/records/rcyfm-68h65/files/{}?download=1"
# SSSP 1.3.0 (Materials Cloud Archive record 2023.65, DOI 10.24435/materialscloud:f3-ym)
FAMILIES = {
    f"SSSP-1.3.0-{fn}-{acc}": {
        "title": f"SSSP {acc} {fn} v1.3.0",
        "archive": _MC.format(f"SSSP_1.3.0_{fn}_{acc}.tar.gz"),
        "json": _MC.format(f"SSSP_1.3.0_{fn}_{acc}.json"),
        "license": "CC BY 4.0 (as stated on the Materials Cloud record page)",
        "reference": "Prandini et al., npj Comput. Mater. 4, 72 (2018); Materials Cloud Archive 2023.65",
    }
    for fn in ("PBE", "PBEsol")
    for acc in ("efficiency", "precision")
}


@router.get("")
async def list_all() -> dict[str, Any]:
    return {
        "pseudos": await asyncio.to_thread(PS.list_pseudos),
        "defaults": PS.get_defaults(),
        "families": [{"id": k, **v} for k, v in FAMILIES.items()],
    }


@router.post("/upload")
async def upload(
    files: list[UploadFile] = File(...), family: str | None = Form(None), make_default: bool = Form(False)
) -> dict[str, Any]:
    items = []
    for f in files:
        items.append((f.filename or "file.upf", await read_upload(f, 1024 * 1024 * 1024)))
    return await asyncio.to_thread(PS.add_files, items, family or None, make_default)


class DefaultIn(BaseModel):
    element: str = Field(..., pattern=r"^[A-Z][a-z]?$")
    filename: str | None = None


@router.put("/defaults")
async def set_default(body: DefaultIn) -> dict[str, Any]:
    try:
        PS.set_default(body.element, body.filename)
    except PS.PseudoError as exc:
        raise bad(str(exc)) from exc
    return {"defaults": PS.get_defaults()}


@router.delete("/{filename}")
async def delete(filename: str) -> dict[str, Any]:
    try:
        PS.delete(filename)
    except PS.PseudoError as exc:
        raise not_found(str(exc)) from exc
    return {"ok": True}


@router.get("/{filename}/download")
async def download(filename: str):
    try:
        p = PS.path_of(filename)
    except PS.PseudoError as exc:
        raise not_found(str(exc)) from exc
    return FileResponse(p, filename=p.name, media_type="text/plain")


class InstallIn(BaseModel):
    family: str | None = None
    url: str | None = None
    make_default: bool = True


async def _get(url: str, task: tasks.Task) -> bytes:
    timeout = httpx.Timeout(60, connect=30)
    async with (
        httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=True) as cli,
        cli.stream("GET", url) as r,
    ):
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code} for {url}")
        total = int(r.headers.get("content-length") or 0)
        buf = bytearray()
        async for chunk in r.aiter_bytes():
            buf.extend(chunk)
            if total:
                task.progress = len(buf) / total
            if len(buf) > 2 * 1024 * 1024 * 1024:
                raise RuntimeError("download too large")
        return bytes(buf)


@router.post("/install")
async def install(body: InstallIn) -> dict[str, Any]:
    if body.family:
        fam = FAMILIES.get(body.family)
        if fam is None:
            raise bad("unknown family")
        urls = [(fam["json"], f"{body.family}.json"), (fam["archive"], f"{body.family}.tar.gz")]
        family_name = body.family
    elif body.url:
        if not re.match(r"^https://", body.url):
            raise bad("only https:// URLs are allowed")
        name = body.url.split("?")[0].rsplit("/", 1)[-1] or "download"
        urls = [(body.url, name)]
        family_name = None
    else:
        raise bad("give a family or a URL")

    async def run(task: tasks.Task) -> dict[str, Any]:
        files = []
        for url, name in urls:
            task.log(f"downloading {url}")
            data = await _get(url, task)
            task.log(f"  {len(data) / 1e6:.1f} MB")
            files.append((name, data))
        res = await asyncio.to_thread(PS.add_files, files, family_name, body.make_default)
        task.log(f"added {len(res['added'])} files")
        for e in res["errors"]:
            task.log(f"  warning: {e}")
        return res

    t = tasks.start(f"Install pseudopotentials {body.family or body.url}", run)
    return {"task_id": t.id}


class CutoffIn(BaseModel):
    filenames: list[str]


@router.post("/cutoffs")
async def cutoffs(body: CutoffIn) -> dict[str, Any]:
    return PS.suggested_cutoffs(body.filenames)

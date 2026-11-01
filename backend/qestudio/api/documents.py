"""Saved input documents."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..db import DocumentRow, session
from .common import not_found

router = APIRouter(prefix="/api/documents", tags=["documents"])


class DocIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    program: str = "pw"
    content: str = Field("", max_length=20_000_000)
    structure_id: str | None = None


def _d(r: DocumentRow, full: bool = True) -> dict[str, Any]:
    d = {
        "id": r.id,
        "name": r.name,
        "program": r.program,
        "structure_id": r.structure_id,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "size": len(r.content or ""),
    }
    if full:
        d["content"] = r.content
    return d


@router.get("")
async def list_docs() -> list[dict[str, Any]]:
    with session() as s:
        return [_d(r, False) for r in s.query(DocumentRow).order_by(DocumentRow.updated_at.desc()).all()]


@router.post("")
async def create_doc(body: DocIn) -> dict[str, Any]:
    with session() as s:
        r = DocumentRow(**body.model_dump())
        s.add(r)
        s.flush()
        return _d(r)


@router.get("/{did}")
async def get_doc(did: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(DocumentRow, did)
        if r is None:
            raise not_found("document")
        return _d(r)


@router.put("/{did}")
async def put_doc(did: str, body: DocIn) -> dict[str, Any]:
    with session() as s:
        r = s.get(DocumentRow, did)
        if r is None:
            raise not_found("document")
        for k, v in body.model_dump().items():
            setattr(r, k, v)
        s.flush()
        return _d(r)


@router.delete("/{did}")
async def del_doc(did: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(DocumentRow, did)
        if r is None:
            raise not_found("document")
        s.delete(r)
    return {"ok": True}

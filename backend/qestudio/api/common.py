"""Shared API helpers."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, UploadFile

MAX_UPLOAD = 2 * 1024 * 1024 * 1024  # 2 GB hard cap for archives


def bad(msg: str, code: int = 400) -> HTTPException:
    return HTTPException(status_code=code, detail=msg)


def not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


async def read_upload(f: UploadFile, limit: int = MAX_UPLOAD) -> bytes:
    chunks, total = [], 0
    while True:
        c = await f.read(1024 * 1024)
        if not c:
            break
        total += len(c)
        if total > limit:
            raise bad(f"file '{f.filename}' is larger than {limit // (1024 * 1024)} MB", 413)
        chunks.append(c)
    return b"".join(chunks)


def dump_dt(d: dict[str, Any]) -> dict[str, Any]:
    return d

"""Background task status."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from .. import tasks
from .common import not_found

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("")
async def list_tasks() -> list[dict[str, Any]]:
    return [t.to_dict(max(0, len(t.lines) - 5)) for t in tasks.all_tasks()[:50]]


@router.get("/{tid}")
async def get_task(tid: str, since: int = 0) -> dict[str, Any]:
    t = tasks.get(tid)
    if t is None:
        raise not_found("task")
    return t.to_dict(since)

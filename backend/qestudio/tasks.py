"""In-memory background tasks with a log (installs, downloads, uploads)."""

from __future__ import annotations

import asyncio
import logging
import time
import traceback
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

log = logging.getLogger(__name__)


class Task:
    def __init__(self, title: str):
        self.id = uuid.uuid4().hex[:10]
        self.title = title
        self.status = "running"  # running | done | failed
        self.lines: list[str] = []
        self.result: Any = None
        self.error: str | None = None
        self.created = time.time()
        self.finished: float | None = None
        self.progress: float | None = None

    def log(self, msg: str) -> None:
        for ln in str(msg).splitlines() or [""]:
            self.lines.append(ln)
        if len(self.lines) > 5000:
            self.lines = self.lines[-4000:]

    def to_dict(self, since: int = 0) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "status": self.status,
            "log": self.lines[since:],
            "log_offset": len(self.lines),
            "result": self.result,
            "error": self.error,
            "progress": self.progress,
            "created": self.created,
            "finished": self.finished,
        }


_tasks: dict[str, Task] = {}
_handles: set[asyncio.Task] = set()


def start(title: str, fn: Callable[[Task], Awaitable[Any]]) -> Task:
    t = Task(title)
    _tasks[t.id] = t

    async def _run() -> None:
        try:
            t.result = await fn(t)
            t.status = "done"
        except Exception as exc:  # report every failure to the UI
            t.status = "failed"
            t.error = str(exc) or type(exc).__name__
            t.log(f"ERROR: {t.error}")
            log.debug("task %s failed: %s", t.id, traceback.format_exc())
        finally:
            t.finished = time.time()

    h = asyncio.create_task(_run())
    _handles.add(h)
    h.add_done_callback(_handles.discard)
    # prune old tasks
    if len(_tasks) > 200:
        for k in sorted(_tasks, key=lambda k: _tasks[k].created)[:50]:
            if _tasks[k].status != "running":
                _tasks.pop(k, None)
    return t


def get(task_id: str) -> Task | None:
    return _tasks.get(task_id)


def all_tasks() -> list[Task]:
    return sorted(_tasks.values(), key=lambda t: -t.created)

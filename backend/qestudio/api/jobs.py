"""Jobs API (+ WebSockets for live logs and global events)."""

from __future__ import annotations

import asyncio
import io
import logging
import zipfile
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from ..analysis import analyze_job
from ..db import JobRow, session
from ..executors.base import ExecutorError
from ..jobs.manager import JobError, job_to_dict, manager
from .common import bad, not_found

router = APIRouter(prefix="/api", tags=["jobs"])
log = logging.getLogger(__name__)


class StepIn(BaseModel):
    label: str = ""
    program: str = Field(..., pattern=r"^([a-z0-9_]+\.x|shell)$")
    input_name: str = Field(..., min_length=1, max_length=200)
    input: str = Field(..., max_length=20_000_000)
    output_name: str | None = None
    cwd: str = "."
    np: int | None = Field(None, ge=1, le=100000)
    args: str = Field("", max_length=500)
    save_xml: str | None = None


class ExtraFile(BaseModel):
    name: str
    content: str


class JobIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    connection_id: str
    steps: list[StepIn] = Field(..., min_length=1, max_length=500)
    kind: str | None = None
    scheduler: Literal["direct", "slurm", "pbs"] | None = None
    resources: dict[str, Any] = Field(default_factory=dict)
    workflow: dict[str, Any] = Field(default_factory=dict)
    structure_id: str | None = None
    extra_files: list[ExtraFile] = Field(default_factory=list)


@router.get("/jobs")
async def list_jobs(status: str | None = None, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
    with session() as s:
        qy = s.query(JobRow)
        if status:
            qy = qy.filter(JobRow.status.in_(status.split(",")))
        rows = qy.order_by(JobRow.created_at.desc()).offset(offset).limit(min(limit, 1000)).all()
        return [job_to_dict(r, with_inputs=False) for r in rows]


@router.post("/jobs")
async def create_job(body: JobIn) -> dict[str, Any]:
    spec = body.model_dump()
    for st in spec["steps"]:
        if not st.get("output_name"):
            st["output_name"] = st["input_name"].rsplit(".", 1)[0] + ".out"
    try:
        return manager.create(spec)
    except JobError as exc:
        raise bad(str(exc)) from exc
    except KeyError:
        raise not_found("connection") from None


@router.get("/jobs/{jid}")
async def get_job(jid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(JobRow, jid)
        if r is None:
            raise not_found("job")
        return job_to_dict(r)


@router.post("/jobs/{jid}/cancel")
async def cancel(jid: str) -> dict[str, Any]:
    try:
        return await manager.cancel(jid)
    except KeyError:
        raise not_found("job") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc


@router.post("/jobs/{jid}/refresh")
async def refresh(jid: str) -> dict[str, Any]:
    try:
        job = await manager.poll(jid)
    except ExecutorError as exc:
        raise bad(str(exc)) from exc
    if job is None:
        raise not_found("job")
    return job


@router.delete("/jobs/{jid}")
async def delete(jid: str, remote: bool = False) -> dict[str, Any]:
    try:
        await manager.delete(jid, remote)
    except KeyError:
        raise not_found("job") from None
    return {"ok": True}


@router.post("/jobs/{jid}/resubmit")
async def resubmit(jid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(JobRow, jid)
        if r is None:
            raise not_found("job")
        j = job_to_dict(r)
    spec = {
        k: j[k]
        for k in ("name", "connection_id", "steps", "kind", "scheduler", "resources", "workflow", "structure_id")
    }
    try:
        return manager.create(spec)
    except JobError as exc:
        raise bad(str(exc)) from exc


@router.get("/jobs/{jid}/files")
async def files(jid: str, source: Literal["remote", "local"] = "local") -> dict[str, Any]:
    if source == "remote":
        try:
            return {"entries": await manager.list_remote(jid)}
        except KeyError:
            raise not_found("job") from None
        except (ExecutorError, FileNotFoundError) as exc:
            raise bad(str(exc)) from exc
    d = manager.local_dir(jid)
    out = []
    if d.exists():
        for p in sorted(d.rglob("*")):
            if p.is_file():
                out.append(
                    {
                        "path": str(p.relative_to(d)).replace("\\", "/"),
                        "size": p.stat().st_size,
                        "mtime": p.stat().st_mtime,
                        "is_dir": False,
                    }
                )
    return {"entries": out}


@router.get("/jobs/{jid}/file")
async def file(
    jid: str,
    path: str,
    source: Literal["remote", "local"] = "local",
    offset: int = 0,
    max_bytes: int = 2_000_000,
    download: bool = False,
) -> Response:
    if ".." in path.split("/"):
        raise bad("invalid path")
    if source == "local":
        d = manager.local_dir(jid)
        p = (d / path).resolve()
        if not str(p).startswith(str(d.resolve())) or not p.is_file():
            raise not_found("file")
        if download:
            return FileResponse(p, filename=p.name)
        with open(p, "rb") as fh:
            fh.seek(offset)
            data = fh.read(max_bytes)
        return Response(data, media_type="text/plain; charset=utf-8", headers={"X-File-Size": str(p.stat().st_size)})
    with session() as s:
        r = s.get(JobRow, jid)
        if r is None:
            raise not_found("job")
        job = job_to_dict(r, with_inputs=False)
    from ..connections import get_executor

    try:
        ex = await get_executor(job["connection_id"])
        data = await ex.read_file(f"{job['remote_dir']}/{path}", offset, max_bytes)
    except FileNotFoundError:
        raise not_found("file") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc
    headers = {"Content-Disposition": f'attachment; filename="{Path(path).name}"'} if download else {}
    return Response(data, media_type="text/plain; charset=utf-8", headers=headers)


@router.post("/jobs/{jid}/fetch")
async def fetch(jid: str, include_large: bool = False) -> dict[str, Any]:
    try:
        return await manager.fetch_results(jid, include_large)
    except KeyError:
        raise not_found("job") from None
    except (ExecutorError, JobError, FileNotFoundError) as exc:
        raise bad(str(exc)) from exc


@router.get("/jobs/{jid}/results")
async def results(jid: str, refresh: bool = False) -> dict[str, Any]:
    with session() as s:
        r = s.get(JobRow, jid)
        if r is None:
            raise not_found("job")
        job = job_to_dict(r)
    if refresh or not job["fetched"]:
        if job["remote_dir"]:
            try:
                await manager.fetch_results(jid)
            except (ExecutorError, JobError, FileNotFoundError) as exc:
                if not manager.local_dir(jid).exists():
                    raise bad(f"cannot fetch results: {exc}") from exc
    d = manager.local_dir(jid)
    return await asyncio.to_thread(analyze_job, d, job["steps"], job["workflow"])


@router.get("/jobs/{jid}/archive")
async def archive(jid: str) -> StreamingResponse:
    d = manager.local_dir(jid)
    if not d.exists():
        raise not_found("results (fetch them first)")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in d.rglob("*"):
            if p.is_file():
                zf.write(p, str(p.relative_to(d)))
    buf.seek(0)
    return StreamingResponse(
        buf, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="job-{jid}.zip"'}
    )


# ----------------------------------------------------------------------------- websockets
@router.websocket("/ws/jobs/{jid}")
async def ws_job(ws: WebSocket, jid: str) -> None:
    """Streams {type:'log', step, data} chunks of the current step's output plus status updates."""
    await ws.accept(subprotocol=_subprotocol(ws))
    manager.subscribe_job(jid)
    offsets: dict[int, int] = {}
    follow_step: int | None = None
    try:
        msg = await asyncio.wait_for(ws.receive_json(), 10)
        follow_step = msg.get("step")
        if isinstance(msg.get("offset"), int) and follow_step:
            offsets[follow_step] = msg["offset"]
    except (asyncio.TimeoutError, Exception):
        pass
    last_key = None
    try:
        while True:
            with session() as s:
                r = s.get(JobRow, jid)
                if r is None:
                    await ws.send_text(_dumps({"type": "error", "message": "job not found"}))
                    break
                job = job_to_dict(r, with_inputs=False)
            key = (job["status"], job["current_step"], bool(job["fetched"]))
            if key != last_key:
                await ws.send_text(_dumps({"type": "status", "job": job}))
                last_key = key
            step = follow_step or job["current_step"] or 1
            try:
                t = await manager.tail(jid, step, offsets.get(step, 0))
                if t["data"]:
                    await ws.send_text(
                        _dumps({"type": "log", "step": t["step"], "data": t["data"], "offset": t["offset"]})
                    )
                offsets[step] = t["offset"]
                more = len(t["data"]) > 0
            except (ExecutorError, OSError) as exc:
                await ws.send_text(_dumps({"type": "warning", "message": f"log unavailable: {exc}"}))
                more = False
            # client may switch step
            try:
                msg = await asyncio.wait_for(ws.receive_json(), 0.05 if more else 1.5)
                if "step" in msg:
                    follow_step = msg.get("step")
                    if isinstance(msg.get("offset"), int) and follow_step:
                        offsets[follow_step] = msg["offset"]
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover
        log.debug("job websocket closed: %s", exc)
    finally:
        manager.unsubscribe_job(jid)


@router.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await ws.accept(subprotocol=_subprotocol(ws))
    qu = manager.subscribe_events()
    try:
        while True:
            try:
                ev = await asyncio.wait_for(qu.get(), 25)
                await ws.send_text(_dumps(ev))
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        manager.unsubscribe_events(qu)


def _subprotocol(ws: WebSocket) -> str | None:
    """Echo the 'qes' subprotocol when the client offered it (token-in-subprotocol auth)."""
    offered = [p.strip() for p in ws.headers.get("sec-websocket-protocol", "").split(",")]
    return "qes" if "qes" in offered else None


def _dumps(ev: dict[str, Any]) -> str:
    import orjson

    return orjson.dumps(ev, option=orjson.OPT_NON_STR_KEYS | orjson.OPT_NAIVE_UTC, default=str).decode()

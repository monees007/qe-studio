"""Compute connections: CRUD, testing, remote file browsing, QE installation."""

from __future__ import annotations

import posixpath
from typing import Any, Literal

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import connections as C
from .. import qe_setup as QS
from .. import tasks
from ..db import ConnectionRow, JobRow, session
from ..executors.base import ExecutorError, q
from ..jobs.manager import JobError, manager
from .common import bad, not_found, read_upload

router = APIRouter(prefix="/api/connections", tags=["connections"])


class ConnIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    kind: Literal["local", "ssh", "jupyter"]
    config: dict[str, Any] = Field(default_factory=dict)
    password: str | None = None
    passphrase: str | None = None
    jupyter_url: str | None = None


def _validated_cfg(kind: str, cfg: dict[str, Any]) -> dict[str, Any]:
    try:
        c = C.ConnectionConfig.model_validate(cfg)
    except Exception as exc:
        raise bad(f"invalid configuration: {exc}") from exc
    if kind == "ssh" and not c.host:
        raise bad("SSH host is required")
    return c.model_dump()


@router.get("")
async def list_conns() -> list[dict[str, Any]]:
    with session() as s:
        return [C.row_to_dict(r) for r in s.query(ConnectionRow).order_by(ConnectionRow.created_at).all()]


@router.post("")
async def create_conn(body: ConnIn) -> dict[str, Any]:
    if body.kind == "local":
        with session() as s:
            if s.query(ConnectionRow).filter(ConnectionRow.kind == "local").count():
                raise bad("a local connection already exists")
    if body.kind == "jupyter" and not body.jupyter_url:
        raise bad("the Jupyter / Kaggle URL is required")
    if body.kind == "jupyter":
        from ..executors.jupyter import parse_jupyter_url

        try:
            parse_jupyter_url(body.jupyter_url or "")
        except ExecutorError as exc:
            raise bad(str(exc)) from exc
    cfg = _validated_cfg(body.kind, body.config)
    with session() as s:
        r = ConnectionRow(name=body.name, kind=body.kind, config=cfg)
        s.add(r)
        s.flush()
        cid = r.id
    C.update_secrets(cid, {"password": body.password, "passphrase": body.passphrase, "jupyter_url": body.jupyter_url})
    return C.get_connection(cid)


@router.get("/{cid}")
async def get_conn(cid: str) -> dict[str, Any]:
    try:
        return C.get_connection(cid)
    except KeyError:
        raise not_found("connection") from None


@router.put("/{cid}")
async def update_conn(cid: str, body: ConnIn) -> dict[str, Any]:
    with session() as s:
        r = s.get(ConnectionRow, cid)
        if r is None:
            raise not_found("connection")
        if r.kind != body.kind:
            raise bad("connection kind cannot be changed")
        cfg = dict(r.config or {})
        detected = cfg.get("detected", {})
        new = _validated_cfg(body.kind, body.config)
        new["detected"] = new.get("detected") or detected
        r.name = body.name
        r.config = new
    C.update_secrets(cid, {"password": body.password, "passphrase": body.passphrase, "jupyter_url": body.jupyter_url})
    await C.drop_executor(cid)
    return C.get_connection(cid)


@router.delete("/{cid}")
async def delete_conn(cid: str) -> dict[str, Any]:
    with session() as s:
        r = s.get(ConnectionRow, cid)
        if r is None:
            raise not_found("connection")
        if r.kind == "local":
            raise bad("the local connection cannot be deleted")
        active = (
            s.query(JobRow)
            .filter(JobRow.connection_id == cid, JobRow.status.in_(("submitting", "queued", "running")))
            .count()
        )
        if active:
            raise bad(f"{active} job(s) are still active on this connection")
        s.delete(r)
    await C.drop_executor(cid)
    C.delete_secrets(cid)
    return {"ok": True}


@router.post("/{cid}/test")
async def test(cid: str) -> dict[str, Any]:
    try:
        C.get_connection(cid)
    except KeyError:
        raise not_found("connection") from None
    return await C.test_connection(cid)


class ExecIn(BaseModel):
    command: str = Field(..., min_length=1, max_length=20000)
    timeout: float = Field(60, gt=0, le=3600)


@router.post("/{cid}/exec")
async def exec_cmd(cid: str, body: ExecIn) -> dict[str, Any]:
    """Run a shell command on the target (diagnostics: 'module avail', 'nvidia-smi', ...)."""
    try:
        conn = C.get_connection(cid)
        ex = await C.get_executor(cid)
        env = conn["config"].get("env_setup") or ""
        r = await ex.run_marked(f"{env}\n{body.command}" if env else body.command, body.timeout)
        return {"stdout": r.stdout[-200_000:], "stderr": r.stderr[-50_000:], "code": r.code}
    except KeyError:
        raise not_found("connection") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc


@router.get("/{cid}/files")
async def files(cid: str, path: str = "", depth: int = 1) -> dict[str, Any]:
    try:
        conn = C.get_connection(cid)
        ex = await C.get_executor(cid)
        p = await ex.expand(path or conn["config"]["work_root"])
        return {"path": p, "entries": await ex.listdir(p, max(1, min(depth, 4)))}
    except KeyError:
        raise not_found("connection") from None
    except FileNotFoundError:
        raise not_found("path") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc


@router.get("/{cid}/file")
async def file(cid: str, path: str, max_bytes: int = 5_000_000) -> Response:
    try:
        ex = await C.get_executor(cid)
        data = await ex.read_file(path, 0, max_bytes)
    except KeyError:
        raise not_found("connection") from None
    except FileNotFoundError:
        raise not_found("file") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc
    return Response(
        data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{posixpath.basename(path)}"'},
    )


# ----------------------------------------------------------------------------- QE setup
class QEConfigIn(BaseModel):
    qe_bin_dir: str | None = None
    env_setup: str | None = None
    mpi_command: str | None = None


@router.put("/{cid}/qe")
async def set_qe(cid: str, body: QEConfigIn) -> dict[str, Any]:
    vals = {k: v for k, v in body.model_dump().items() if v is not None}
    try:
        C.set_config_values(cid, vals)
    except KeyError:
        raise not_found("connection") from None
    await C.drop_executor(cid)
    return await C.test_connection(cid)


class InstallIn(BaseModel):
    method: Literal["conda", "apt"] = "conda"
    version: str | None = Field(None, pattern=r"^\d+(\.\d+){0,2}$")
    mpi: Literal["openmpi", "mpich"] = "openmpi"
    install_dir: str | None = None


@router.post("/{cid}/qe/install")
async def install_qe(cid: str, body: InstallIn) -> dict[str, Any]:
    """Install precompiled QE on the target as a tracked job (log visible on the Jobs page)."""
    try:
        conn = C.get_connection(cid)
    except KeyError:
        raise not_found("connection") from None
    if conn["kind"] == "local" and QS.IS_WINDOWS:
        raise bad("automatic installation is not available on Windows; use WSL or upload binaries")
    if body.method == "conda":
        root = body.install_dir or posixpath.join(conn["config"]["work_root"], "qe-tools")
        try:
            ex = await C.get_executor(cid)
            root = await ex.expand(root)
        except ExecutorError as exc:
            raise bad(str(exc)) from exc
        try:
            script = QS.conda_install_script(root, body.version, body.mpi)
        except ValueError as exc:
            raise bad(str(exc)) from exc
        name = f"Install QE {body.version or 'latest'} (conda-forge, {body.mpi})"
    else:
        script = QS.apt_install_script()
        name = "Install QE (apt quantum-espresso)"
    spec = {
        "name": name,
        "connection_id": cid,
        "kind": "install",
        "scheduler": "direct",
        "steps": [
            {
                "label": name,
                "program": "shell",
                "input_name": "install.sh",
                "input": script,
                "output_name": "install.log",
                "cwd": ".",
            }
        ],
        "workflow": {"kind": "install", "method": body.method, "mpi": body.mpi, "target_connection": cid},
        "resources": {"np": 1, "nthreads": 1},
    }
    try:
        return manager.create(spec)
    except JobError as exc:
        raise bad(str(exc)) from exc


@router.post("/{cid}/qe/archive")
async def upload_archive(cid: str, file: UploadFile = File(...)) -> dict[str, Any]:
    """Bring-your-own precompiled binaries: tar.gz/zip/.conda/.deb containing pw.x (or pw.exe)."""
    try:
        C.get_connection(cid)
    except KeyError:
        raise not_found("connection") from None
    name = file.filename or "qe.tar.gz"
    if not name.lower().endswith(QS.ARCHIVE_EXT):
        raise bad(f"unsupported archive type; use one of {', '.join(QS.ARCHIVE_EXT)}")
    data = await read_upload(file)

    async def run(task: tasks.Task) -> dict[str, Any]:
        return await QS.install_archive(cid, data, name, task)

    t = tasks.start(f"Install binaries from {name}", run)
    return {"task_id": t.id}


@router.get("/{cid}/qe/detect")
async def detect(cid: str) -> dict[str, Any]:
    try:
        conn = C.get_connection(cid)
        ex = await C.get_executor(cid)
        return await C.probe(ex, conn)
    except KeyError:
        raise not_found("connection") from None
    except ExecutorError as exc:
        raise bad(str(exc)) from exc


@router.get("/{cid}/modules")
async def modules(cid: str) -> dict[str, Any]:
    """List environment modules mentioning espresso (HPC convenience)."""
    try:
        ex = await C.get_executor(cid)
        r = await ex.run_marked("(module -t avail 2>&1 || true) | grep -i -E 'espresso|^qe|/qe' | head -50", 60)
        return {"modules": [x.strip() for x in r.stdout.splitlines() if x.strip()]}
    except ExecutorError as exc:
        raise bad(str(exc)) from exc


__all__ = ["q", "router"]

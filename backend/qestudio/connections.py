"""Compute connections (local / SSH / Jupyter-Kaggle): config model, executor pool,
connection tests and Quantum ESPRESSO detection / installation helpers."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from .config import get_env
from .db import ConnectionRow, session
from .executors.base import Executor, ExecutorError, q
from .executors.jupyter import JupyterExecutor
from .executors.local import IS_WINDOWS, LocalExecutor
from .executors.ssh import SSHExecutor
from .secrets_store import get_secret, set_secret

log = logging.getLogger(__name__)

QE_PROGRAMS = ["pw.x", "ph.x", "pp.x", "dos.x", "projwfc.x", "bands.x", "q2r.x", "matdyn.x", "hp.x", "neb.x"]


class ConnectionConfig(BaseModel):
    # ---- common
    work_root: str = ""  # where job directories are created (default: ~/qe-studio-runs)
    qe_bin_dir: str = ""  # directory containing pw.x etc. ('' = use PATH after env_setup)
    env_setup: str = ""  # shell lines run before every job (e.g. 'module load qe/7.3')
    mpi_command: str = "mpirun -np {np}"  # direct runs; {np}, {nthreads} placeholders; '' = serial
    mpi_command_batch: str = ""  # inside SLURM/PBS jobs (default: srun / mpirun -np {np})
    default_np: int = Field(1, ge=1, le=100000)
    default_nthreads: int = Field(1, ge=1, le=1024)
    scheduler: Literal["direct", "slurm", "pbs"] = "direct"
    scheduler_defaults: dict[str, Any] = Field(default_factory=dict)
    login_shell: bool | None = None  # default: True for SSH, False otherwise
    # ---- ssh
    host: str = ""
    port: int = 22
    username: str = ""
    auth: Literal["key", "password", "agent"] = "key"
    key_path: str = ""
    jump_host: str = ""
    host_key_policy: Literal["tofu", "strict", "ignore"] = "tofu"
    # ---- jupyter
    kernel_name: str = "python3"
    # ---- detected (filled by tests)
    detected: dict[str, Any] = Field(default_factory=dict)


SECRET_FIELDS = {"password", "passphrase", "jupyter_url"}


def default_work_root(kind: str) -> str:
    if kind == "local":
        return str(get_env().local_runs_dir)
    if kind == "jupyter":
        return "/kaggle/working/qe-studio-runs"
    return "~/qe-studio-runs"


def row_to_dict(row: ConnectionRow) -> dict[str, Any]:
    cfg = ConnectionConfig.model_validate(row.config or {}).model_dump()
    if cfg["login_shell"] is None:
        cfg["login_shell"] = row.kind == "ssh"
    if not cfg["work_root"]:
        cfg["work_root"] = default_work_root(row.kind)
    secrets = {
        "has_password": bool(get_secret(f"ssh:{row.id}:password")),
        "has_passphrase": bool(get_secret(f"ssh:{row.id}:passphrase")),
        "has_jupyter_url": bool(get_secret(f"jupyter:{row.id}:url")),
    }
    url = get_secret(f"jupyter:{row.id}:url") if row.kind == "jupyter" else None
    return {
        "id": row.id,
        "name": row.name,
        "kind": row.kind,
        "config": cfg,
        **secrets,
        "jupyter_host": re.sub(r"^https?://([^/]+).*$", r"\1", url) if url else None,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def get_connection(conn_id: str) -> dict[str, Any]:
    with session() as s:
        row = s.get(ConnectionRow, conn_id)
        if row is None:
            raise KeyError(conn_id)
        return row_to_dict(row)


def ensure_local_connection() -> str:
    """Create the built-in 'This computer' connection on first start."""
    with session() as s:
        row = s.query(ConnectionRow).filter(ConnectionRow.kind == "local").first()
        if row:
            return row.id
        cfg = ConnectionConfig(work_root=str(get_env().local_runs_dir))
        if IS_WINDOWS:
            cfg.mpi_command = ""
        row = ConnectionRow(name="This computer", kind="local", config=cfg.model_dump())
        s.add(row)
        s.flush()
        return row.id


def update_secrets(conn_id: str, values: dict[str, str | None]) -> None:
    for k, v in values.items():
        if v is None:
            continue
        if k == "password":
            set_secret(f"ssh:{conn_id}:password", v or None)
        elif k == "passphrase":
            set_secret(f"ssh:{conn_id}:passphrase", v or None)
        elif k == "jupyter_url":
            set_secret(f"jupyter:{conn_id}:url", v.strip() or None)


def delete_secrets(conn_id: str) -> None:
    for name in (f"ssh:{conn_id}:password", f"ssh:{conn_id}:passphrase", f"jupyter:{conn_id}:url"):
        set_secret(name, None)


# ----------------------------------------------------------------------------- executor pool
_pool: dict[str, tuple[str, Executor]] = {}
_pool_lock: asyncio.Lock | None = None


def init_pool() -> None:
    """(Re)create the executor pool on the running event loop (called at startup)."""
    global _pool_lock
    _pool.clear()
    _pool_lock = asyncio.Lock()


def _make_executor(conn: dict[str, Any]) -> Executor:
    cfg = dict(conn["config"])
    cfg["kind"] = conn["kind"]
    if conn["kind"] == "local":
        return LocalExecutor(conn["id"], cfg)
    if conn["kind"] == "ssh":
        return SSHExecutor(conn["id"], cfg)
    if conn["kind"] == "jupyter":
        url = get_secret(f"jupyter:{conn['id']}:url")
        if not url:
            raise ExecutorError("no Jupyter / Kaggle URL stored for this connection")
        return JupyterExecutor(conn["id"], cfg, url)
    raise ExecutorError(f"unknown connection kind {conn['kind']}")


async def get_executor(conn_id: str) -> Executor:
    conn = get_connection(conn_id)
    stamp = f"{conn['updated_at']}"
    if _pool_lock is None:
        init_pool()
    assert _pool_lock is not None
    async with _pool_lock:
        cur = _pool.get(conn_id)
        if cur and cur[0] == stamp:
            return cur[1]
        if cur:
            try:
                await cur[1].close()
            except Exception:
                pass
        ex = _make_executor(conn)
        _pool[conn_id] = (stamp, ex)
    await ex.connect()
    return ex


async def drop_executor(conn_id: str) -> None:
    cur = _pool.pop(conn_id, None)
    if cur:
        try:
            if isinstance(cur[1], JupyterExecutor):
                await cur[1].close(shutdown_kernel=True)
            else:
                await cur[1].close()
        except Exception:
            pass


async def close_all() -> None:
    for cid in list(_pool):
        await drop_executor(cid)


# ----------------------------------------------------------------------------- probing
PROBE = r"""
B={bin}
[ -n "$B" ] && export PATH="$B:$PATH"
echo "__HOST__ $(hostname 2>/dev/null)"
echo "__UNAME__ $(uname -sm 2>/dev/null)"
echo "__UID__ $(id -u 2>/dev/null)"
echo "__NPROC__ $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"
echo "__MEM__ $(free -m 2>/dev/null | awk '/Mem:/{{print $2}}')"
echo "__PY__ $(command -v python3 2>/dev/null)"
echo "__DISK__ $(df -Pm {root} 2>/dev/null | awk 'NR==2{{print $4}}')"
for p in {progs}; do echo "__PROG__ $p $(command -v $p 2>/dev/null)"; done
echo "__MPI__ $(command -v mpirun 2>/dev/null) | $(command -v mpiexec 2>/dev/null) | $(command -v srun 2>/dev/null)"
echo "__SCHED__ $(command -v sbatch 2>/dev/null) | $(command -v qsub 2>/dev/null)"
echo "__NET__ $(command -v curl 2>/dev/null) | $(command -v wget 2>/dev/null)"
PW=$(command -v pw.x 2>/dev/null)
if [ -n "$PW" ]; then
  if command -v timeout >/dev/null 2>&1; then T="timeout 40"; else T=""; fi
  V=$(echo "" | $T "$PW" 2>&1 | grep -m1 "Program PWSCF")
  echo "__VER__ $V"
  if command -v ldd >/dev/null 2>&1; then echo "__LDD__ $(ldd "$PW" 2>/dev/null | grep 'not found' | tr '\n' ';')"; fi
fi
"""


def _parse_probe(text: str) -> dict[str, Any]:
    info: dict[str, Any] = {"programs": {}, "mpi": {}, "schedulers": {}}
    for ln in text.splitlines():
        m = re.match(r"^__(\w+)__\s?(.*)$", ln.strip())
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if k == "PROG":
            parts = v.split(" ", 1)
            info["programs"][parts[0]] = parts[1].strip() if len(parts) > 1 and parts[1].strip() else None
        elif k == "MPI":
            a = [x.strip() or None for x in v.split("|")]
            info["mpi"] = {
                "mpirun": a[0] if a else None,
                "mpiexec": a[1] if len(a) > 1 else None,
                "srun": a[2] if len(a) > 2 else None,
            }
        elif k == "SCHED":
            a = [x.strip() or None for x in v.split("|")]
            info["schedulers"] = {"sbatch": a[0] if a else None, "qsub": a[1] if len(a) > 1 else None}
        elif k == "NET":
            a = [x.strip() or None for x in v.split("|")]
            info["downloaders"] = {"curl": a[0] if a else None, "wget": a[1] if len(a) > 1 else None}
        elif k == "VER":
            mm = re.search(r"PWSCF v\.?\s*(\S+)", v)
            info["qe_version"] = mm.group(1) if mm else None
        elif k == "LDD":
            info["missing_libs"] = [x.strip() for x in v.split(";") if x.strip()]
        elif k in ("NPROC", "MEM", "UID", "DISK"):
            try:
                info[k.lower()] = int(v.split()[0]) if v else None
            except ValueError:
                info[k.lower()] = None
        else:
            info[k.lower()] = v or None
    info["qe_found"] = bool(info["programs"].get("pw.x"))
    return info


async def probe(ex: Executor, conn: dict[str, Any]) -> dict[str, Any]:
    cfg = conn["config"]
    if isinstance(ex, LocalExecutor) and IS_WINDOWS and not ex.posix:
        return _probe_windows(cfg)
    root = await ex.expand(cfg["work_root"])
    script = (
        (cfg.get("env_setup") or "")
        + "\n"
        + PROBE.format(bin=q(cfg.get("qe_bin_dir") or ""), root=q(root if root else "."), progs=" ".join(QE_PROGRAMS))
    )
    r = await ex.run_marked(script, timeout=120)
    info = _parse_probe(r.stdout)
    info["work_root"] = root
    if r.stderr.strip():
        info["stderr"] = r.stderr.strip()[-2000:]
    return info


def _probe_windows(cfg: dict[str, Any]) -> dict[str, Any]:
    bin_dir = cfg.get("qe_bin_dir") or ""
    progs = {}
    for p in QE_PROGRAMS:
        cand = None
        for name in (p, p[:-2] + ".exe", p + ".exe"):
            path = Path(bin_dir) / name if bin_dir else None
            if path and path.exists():
                cand = str(path)
                break
            w = shutil.which(name)
            if w:
                cand = w
                break
        progs[p] = cand
    return {
        "programs": progs,
        "qe_found": bool(progs.get("pw.x")),
        "uname": platform.platform(),
        "nproc": os.cpu_count(),
        "mpi": {"mpiexec": shutil.which("mpiexec")},
        "schedulers": {},
        "host": platform.node(),
        "work_root": cfg.get("work_root"),
    }


async def test_connection(conn_id: str) -> dict[str, Any]:
    conn = get_connection(conn_id)
    logs: list[str] = []
    try:
        await drop_executor(conn_id)
        ex = await get_executor(conn_id)
        logs.append(f"connected ({conn['kind']})")
        info = await probe(ex, conn)
        fp = getattr(ex, "host_key_fingerprint", None)
        if fp:
            info["host_key_fingerprint"] = fp
            if getattr(ex, "host_key_new", False):
                logs.append(f"new host key trusted (TOFU): {fp}")
        if isinstance(ex, JupyterExecutor):
            info["kernel_id"] = ex.kernel_id
        await ex.mkdir(info.get("work_root") or conn["config"]["work_root"])
        logs.append(f"work directory ready: {info.get('work_root')}")
        _store_detected(conn_id, info)
        return {"ok": True, "info": info, "log": logs}
    except (ExecutorError, OSError) as exc:
        return {"ok": False, "error": str(exc), "log": logs}


def _store_detected(conn_id: str, info: dict[str, Any]) -> None:
    """Save probe results without bumping updated_at (which would recycle the executor)."""
    from sqlalchemy import update

    with session() as s:
        row = s.get(ConnectionRow, conn_id)
        if row is None:
            return
        cfg = dict(row.config or {})
        cfg["detected"] = {
            k: info.get(k)
            for k in (
                "host",
                "uname",
                "nproc",
                "mem",
                "qe_version",
                "qe_found",
                "programs",
                "mpi",
                "schedulers",
                "uid",
                "missing_libs",
                "work_root",
            )
        }
        old = row.updated_at
        s.expunge(row)
        s.execute(update(ConnectionRow).where(ConnectionRow.id == conn_id).values(config=cfg, updated_at=old))


def set_config_values(conn_id: str, values: dict[str, Any]) -> None:
    with session() as s:
        row = s.get(ConnectionRow, conn_id)
        if row is None:
            raise KeyError(conn_id)
        cfg = dict(row.config or {})
        cfg.update(values)
        row.config = ConnectionConfig.model_validate(cfg).model_dump()

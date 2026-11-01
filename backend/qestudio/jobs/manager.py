"""Job lifecycle: submission, monitoring, cancellation, result retrieval and live log tailing.

A job is a list of steps executed by a generated runner script inside one job directory on
the target. The runner records its progress in ``<job>/.qes/`` (pid, state, step, exit_code),
so the state survives restarts of QE Studio and network interruptions; this module only
*observes* those files (polling) and never keeps per-job processes of its own.

Status flow::

    created -> submitting -> queued -> running -> done | failed | cancelled | lost
"""

from __future__ import annotations

import asyncio
import logging
import posixpath
import re
import shutil
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import pseudos as PS
from ..analysis import analyze_job
from ..config import get_env
from ..connections import get_connection, get_executor, set_config_values
from ..db import JobRow, session, utcnow
from ..executors.base import Executor, ExecutorError, OutcomeUnknownError, q
from ..executors.local import IS_WINDOWS, LocalExecutor
from ..settings import load_settings
from .inputs import JobError, prepare_inputs, slugify
from .results import brief_summary, wanted
from .runner import build_runner_py, build_runner_sh
from .schedulers import get_scheduler

log = logging.getLogger(__name__)

ACTIVE = ("submitting", "queued", "running")
FINAL = ("done", "failed", "cancelled", "lost")
STATE_FILES = ["state", "step", "exit_code", "pid", "started", "finished", "sched_id"]
RUNNER_START_TIMEOUT_S = 10.0
NEVER_STARTED_AFTER_S = 120.0

__all__ = ["ACTIVE", "FINAL", "JobError", "JobManager", "job_to_dict", "manager"]


def job_to_dict(row: JobRow, with_inputs: bool = True) -> dict[str, Any]:
    """API representation of a job row (``with_inputs=False`` drops the input texts)."""
    try:
        conn_name = get_connection(row.connection_id)["name"]
    except KeyError:
        conn_name = None
    steps = row.steps or []
    if not with_inputs:
        steps = [{k: v for k, v in st.items() if k != "input"} for st in steps]
    return {
        "id": row.id,
        "name": row.name,
        "connection_id": row.connection_id,
        "connection_name": conn_name,
        "status": row.status,
        "kind": row.kind,
        "steps": steps,
        "resources": row.resources or {},
        "workflow": row.workflow or {},
        "remote_dir": row.remote_dir,
        "scheduler": row.scheduler,
        "remote_job_id": row.remote_job_id,
        "current_step": row.current_step,
        "exit_code": row.exit_code,
        "error": row.error,
        "summary": row.summary or {},
        "structure_id": row.structure_id,
        "fetched": bool(row.fetched),
        "created_at": row.created_at,
        "submitted_at": row.submitted_at,
        "started_at": row.started_at,
        "finished_at": row.finished_at,
    }


def _join(ex: Executor, base: str, rel: str) -> str:
    """Join a job-relative POSIX path onto a target path (handles Windows local targets)."""
    if ex.posix:
        return posixpath.join(base, rel)
    return str(Path(base) / Path(rel))


class JobManager:
    def __init__(self) -> None:
        self._monitor_task: asyncio.Task | None = None
        self._stop: asyncio.Event | None = None  # created in start() on the running loop
        self._background: set[asyncio.Task] = set()
        self._event_queues: set[asyncio.Queue] = set()
        self._log_viewers: Counter[str] = Counter()  # job id -> open live-log views (faster polling)
        self._polling: set[str] = set()

    # ================================================================ lifecycle
    async def start(self) -> None:
        self._stop = asyncio.Event()
        self._polling.clear()
        self._monitor_task = asyncio.create_task(self._monitor(), name="qes-job-monitor")

    async def stop(self) -> None:
        if self._stop is not None:
            self._stop.set()
        if self._monitor_task:
            self._monitor_task.cancel()
            try:
                await self._monitor_task
            except (asyncio.CancelledError, Exception):
                pass

    def _run_in_background(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._background.add(task)
        task.add_done_callback(self._background.discard)

    # ================================================================ events
    def subscribe_events(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._event_queues.add(queue)
        return queue

    def unsubscribe_events(self, queue: asyncio.Queue) -> None:
        self._event_queues.discard(queue)

    def _emit(self, event: dict[str, Any]) -> None:
        for queue in list(self._event_queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def subscribe_job(self, job_id: str) -> None:
        self._log_viewers[job_id] += 1

    def unsubscribe_job(self, job_id: str) -> None:
        self._log_viewers[job_id] -= 1
        if self._log_viewers[job_id] <= 0:
            del self._log_viewers[job_id]

    # ================================================================ persistence helpers
    def _load(self, job_id: str, with_inputs: bool = False) -> dict[str, Any]:
        with session() as s:
            row = s.get(JobRow, job_id)
            if row is None:
                raise KeyError(job_id)
            return job_to_dict(row, with_inputs)

    def _update(self, job_id: str, **values: Any) -> dict[str, Any] | None:
        with session() as s:
            row = s.get(JobRow, job_id)
            if row is None:
                return None
            for key, value in values.items():
                setattr(row, key, value)
            s.flush()
            job = job_to_dict(row, with_inputs=False)
        self._emit({"type": "job", "job": job})
        return job

    def _patch_summary(self, job_id: str, set_: dict[str, Any] | None = None, drop: tuple[str, ...] = ()) -> None:
        with session() as s:
            row = s.get(JobRow, job_id)
            if row is None:
                return
            summary = dict(row.summary or {})
            for key in drop:
                summary.pop(key, None)
            summary.update(set_ or {})
            if summary != (row.summary or {}):
                row.summary = summary

    def local_dir(self, job_id: str) -> Path:
        """Local cache of downloaded results."""
        return get_env().jobs_cache_dir / job_id

    # ================================================================ create & submit
    def create(self, spec: dict[str, Any]) -> dict[str, Any]:
        """Validate a job spec, store it and start the submission in the background."""
        conn = get_connection(spec["connection_id"])
        if not spec.get("steps"):
            raise JobError("job has no steps")
        resources = dict(conn["config"].get("scheduler_defaults") or {})
        resources.setdefault("np", conn["config"].get("default_np", 1))
        resources.setdefault("nthreads", conn["config"].get("default_nthreads", 1))
        resources.update({k: v for k, v in (spec.get("resources") or {}).items() if v not in (None, "")})
        steps, pseudos = prepare_inputs(spec["steps"], bool(resources.get("keep_paths")))
        missing = sorted(p for p in pseudos if p not in PS.known_filenames())
        if missing and not spec.get("skip_pseudo_check"):
            raise JobError(
                "pseudopotential(s) not in your library: "
                + ", ".join(missing)
                + ". Upload them on the Pseudopotentials page."
            )
        extra_files = spec.get("extra_files") or []
        with session() as s:
            row = JobRow(
                name=spec.get("name") or "job",
                connection_id=conn["id"],
                status="created",
                kind=spec.get("kind") or (spec.get("workflow") or {}).get("kind") or "custom",
                steps=steps,
                resources=resources,
                workflow=spec.get("workflow") or {},
                scheduler=spec.get("scheduler") or conn["config"].get("scheduler", "direct"),
                structure_id=spec.get("structure_id"),
                summary={"pseudos": sorted(pseudos), "extra_files": [f["name"] for f in extra_files]},
            )
            s.add(row)
            s.flush()
            job = job_to_dict(row)
        self._run_in_background(self.submit(job["id"], extra_files))
        return job

    async def submit(self, job_id: str, extra_files: list[dict[str, Any]] | None = None) -> None:
        """Stage files on the target and start the runner. Never raises: failures mark the job failed."""
        self._update(job_id, status="submitting", error="", submitted_at=utcnow())
        try:
            job = self._load(job_id, with_inputs=True)
            conn = get_connection(job["connection_id"])
            ex = await get_executor(conn["id"])
            root = await ex.expand(conn["config"]["work_root"])
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            job["remote_dir"] = _join(ex, root, f"{stamp}-{slugify(job['name'])}-{job_id}")
            runner = await self._stage(ex, job, conn, extra_files or [])
            self._update(job_id, remote_dir=job["remote_dir"])
            scheduler = get_scheduler(job["scheduler"])
            try:
                sub = await scheduler.submit(ex, job["remote_dir"], runner, bool(conn["config"].get("login_shell")))
            except OutcomeUnknownError as exc:
                # the connection dropped mid-launch: adopt the job if its runner did start
                if job["scheduler"] != "direct":
                    raise JobError(f"{exc}. Check the queue before resubmitting.") from exc
                pid = await self._wait_for_runner(ex, job["remote_dir"])
                self._update(job_id, status="running", remote_job_id=pid, started_at=utcnow())
                return
            remote_id = sub.remote_id
            if sub.status == "running":
                remote_id = await self._wait_for_runner(ex, job["remote_dir"]) or remote_id
            self._update(
                job_id,
                status=sub.status,
                remote_job_id=remote_id,
                started_at=utcnow() if sub.status == "running" else None,
            )
        except (JobError, ExecutorError, OSError, PS.PseudoError) as exc:
            log.warning("submission of %s failed: %s", job_id, exc)
            self._update(job_id, status="failed", error=f"submission failed: {exc}", finished_at=utcnow())
        except Exception as exc:  # pragma: no cover - unexpected; still reported to the user
            log.exception("submission of %s failed", job_id)
            self._update(job_id, status="failed", error=f"submission failed: {exc}", finished_at=utcnow())

    async def _stage(
        self, ex: Executor, job: dict[str, Any], conn: dict[str, Any], extra_files: list[dict[str, Any]]
    ) -> str:
        """Upload pseudopotentials, inputs, extra files and the runner. Returns the runner file name."""
        job_dir = job["remote_dir"]
        await ex.mkdir(job_dir)
        await ex.mkdir(_join(ex, job_dir, ".qes"))
        for name in job["summary"].get("pseudos", []):
            await ex.write_file(_join(ex, job_dir, f"pseudo/{name}"), PS.path_of(name).read_bytes())
        for step in job["steps"]:
            rel = posixpath.normpath(posixpath.join(step.get("cwd") or ".", step["input_name"]))
            mode = 0o755 if step["program"] == "shell" else None
            await ex.write_file(_join(ex, job_dir, rel), step["input"].encode(), mode)
        for extra in extra_files:
            name = extra["name"]
            if not re.match(r"^[A-Za-z0-9_.\-/]+$", name) or ".." in name.split("/"):
                raise JobError(f"invalid extra file name {name}")
            content = extra.get("content")
            data = content.encode() if isinstance(content, str) else bytes(content or b"")
            await ex.write_file(_join(ex, job_dir, name), data)
        conn_cfg = {**conn["config"], "kind": conn["kind"]}
        if isinstance(ex, LocalExecutor) and IS_WINDOWS and not ex.posix:
            await ex.write_file(_join(ex, job_dir, "run.py"), build_runner_py(job, conn_cfg).encode())
            return "run.py"
        await ex.write_file(_join(ex, job_dir, "run.sh"), build_runner_sh(job, conn_cfg).encode(), 0o755)
        return "run.sh"

    async def _wait_for_runner(self, ex: Executor, job_dir: str) -> str:
        """Wait until the runner wrote its PID; raises JobError with the runner log otherwise."""
        deadline = time.monotonic() + RUNNER_START_TIMEOUT_S
        qes_dir = _join(ex, job_dir, ".qes")
        while time.monotonic() < deadline:
            pid = (await ex.read_small_files(qes_dir, ["pid"])).get("pid", "")
            if pid:
                return pid
            await asyncio.sleep(0.25)
        log_text = (await ex.read_small_files(qes_dir, ["runner.log"])).get("runner.log", "")
        raise JobError(f"runner did not start. {log_text[-1500:]}".strip())

    # ================================================================ monitoring
    async def _read_state(self, ex: Executor, job_dir: str) -> dict[str, str]:
        return await ex.read_small_files(_join(ex, job_dir, ".qes"), STATE_FILES)

    async def poll(self, job_id: str) -> dict[str, Any] | None:
        """Refresh one job's status from its state files (and the scheduler)."""
        try:
            job = self._load(job_id)
        except KeyError:
            return None
        if job["status"] not in ("queued", "running") or not job["remote_dir"]:
            return job
        ex = await get_executor(job["connection_id"])
        scheduler = get_scheduler(job["scheduler"])
        state_files = await self._read_state(ex, job["remote_dir"])
        state = state_files.get("state")
        updates: dict[str, Any] = {}
        step = state_files.get("step", "")
        if step.isdigit() and int(step) != job["current_step"]:
            updates["current_step"] = int(step)

        if state in ("done", "failed", "cancelled"):
            code_text = state_files.get("exit_code", "")
            code = int(code_text) if code_text.lstrip("-").isdigit() else None
            updates.update(status=state, exit_code=code, finished_at=utcnow())
            if state == "failed":
                updates["error"] = f"step {step or '?'} exited with code {code}"
        elif state == "running":
            if job["status"] != "running":
                updates.update(status="running", started_at=utcnow())
            if job["scheduler"] == "direct":
                pid = state_files.get("pid") or job["remote_job_id"]
                alive = pid.isdigit() and await ex.pid_alive(int(pid))
            else:
                alive = (await scheduler.queue_state(ex, job["remote_job_id"]))[0] is not None
            if not alive and (await self._read_state(ex, job["remote_dir"])).get("state") == "running":
                updates.update(
                    status="lost",
                    finished_at=utcnow(),
                    error="the runner process disappeared (machine reboot, out-of-memory kill, "
                    "session timeout or scheduler kill). Partial outputs are kept.",
                )
        elif job["scheduler"] != "direct":  # queued, no state file yet
            queue_state, detail = await scheduler.queue_state(ex, job["remote_job_id"])
            if queue_state is None and not (await self._read_state(ex, job["remote_dir"])).get("state"):
                updates.update(
                    status="failed",
                    finished_at=utcnow(),
                    error=f"job left the queue without starting. {detail}".strip(),
                )
        else:
            submitted = job["submitted_at"]
            if submitted and (utcnow() - submitted).total_seconds() > NEVER_STARTED_AFTER_S:
                updates.update(status="failed", finished_at=utcnow(), error="runner never started")

        if updates:
            job = self._update(job_id, **updates) or job
            if updates.get("status") in FINAL:
                self._run_in_background(self.on_finished(job_id))
        return job

    async def _monitor(self) -> None:
        """Poll active jobs: every ``poll_interval_s`` when someone watches the log, else >= 10 s."""
        last_poll: dict[str, float] = {}
        assert self._stop is not None
        while not self._stop.is_set():
            interval = load_settings().poll_interval_s
            try:
                with session() as s:
                    active = [r.id for r in s.query(JobRow).filter(JobRow.status.in_(("queued", "running")))]
                now = time.monotonic()
                for job_id in active:
                    period = interval if self._log_viewers.get(job_id) else max(interval, 10.0)
                    if job_id in self._polling or now - last_poll.get(job_id, 0.0) < period:
                        continue
                    last_poll[job_id] = now
                    self._polling.add(job_id)
                    self._run_in_background(self._poll_safely(job_id))
            except Exception:
                log.exception("monitor iteration failed")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass

    async def _poll_safely(self, job_id: str) -> None:
        """Network errors are recorded as ``summary.poll_error``; they never fail a job."""
        try:
            await self.poll(job_id)
            self._patch_summary(job_id, drop=("poll_error",))
        except Exception as exc:
            log.info("poll of %s failed: %s", job_id, exc)
            self._patch_summary(job_id, {"poll_error": f"{exc}"[:300]})
        finally:
            self._polling.discard(job_id)

    async def on_finished(self, job_id: str) -> None:
        try:
            await self.fetch_results(job_id)
        except Exception as exc:
            log.warning("fetching results of %s failed: %s", job_id, exc)
            self._patch_summary(job_id, {"fetch_error": str(exc)})
            job = self._load(job_id)
            self._emit({"type": "job", "job": job})
            return
        job = self._load(job_id)
        if job["kind"] == "install" and job["status"] == "done":
            await self._finish_install(job)

    async def _finish_install(self, job: dict[str, Any]) -> None:
        """After a QE install job: point the connection at the new binaries and re-test it."""
        from ..connections import test_connection

        log_text = self.local_dir(job["id"]) / "install.log"
        found = re.findall(r"QES_BIN_DIR=(\S+)", log_text.read_text(errors="replace") if log_text.exists() else "")
        if not found:
            return
        bin_dir = found[-1]
        workflow = job["workflow"] or {}
        values: dict[str, Any] = {"qe_bin_dir": bin_dir}
        if workflow.get("method") == "conda" and workflow.get("mpi") != "none":
            values["mpi_command"] = f"{bin_dir}/mpirun -np {{np}}"
        target = workflow.get("target_connection") or job["connection_id"]
        set_config_values(target, values)
        await test_connection(target)

    # ================================================================ control
    async def cancel(self, job_id: str) -> dict[str, Any]:
        job = self._load(job_id)
        if job["status"] not in ACTIVE:
            return job
        if job["status"] == "submitting" or not job["remote_dir"]:
            return self._update(job_id, status="cancelled", finished_at=utcnow()) or job
        ex = await get_executor(job["connection_id"])
        state_files = await self._read_state(ex, job["remote_dir"])
        await get_scheduler(job["scheduler"]).cancel(ex, job["remote_job_id"], state_files.get("pid"))
        await asyncio.sleep(1.0)
        if (await self._read_state(ex, job["remote_dir"])).get("state") in ("running", None, "") and ex.posix:
            # runner died without running its trap (or the scheduler cancelled it before start)
            await ex.run_marked(
                f"cd {q(job['remote_dir'])} && echo cancelled > .qes/state && date +%s > .qes/finished", 30
            )
        job = self._update(job_id, status="cancelled", finished_at=utcnow(), error="cancelled by user") or job
        self._run_in_background(self.on_finished(job_id))
        return job

    async def delete(self, job_id: str, remote: bool = False) -> None:
        job = self._load(job_id)
        if job["status"] in ACTIVE:
            try:
                await self.cancel(job_id)
            except Exception as exc:
                log.warning("cancel before delete of %s failed: %s", job_id, exc)
        if remote and job["remote_dir"]:
            try:
                ex = await get_executor(job["connection_id"])
                await ex.remove_tree(job["remote_dir"])
            except Exception as exc:
                log.warning("remote cleanup of %s failed: %s", job_id, exc)
        shutil.rmtree(self.local_dir(job_id), ignore_errors=True)
        with session() as s:
            row = s.get(JobRow, job_id)
            if row is not None:
                s.delete(row)
        self._emit({"type": "job_deleted", "id": job_id})

    # ================================================================ results
    async def list_remote(self, job_id: str, depth: int = 4) -> list[dict[str, Any]]:
        job = self._load(job_id)
        if not job["remote_dir"]:
            return []
        ex = await get_executor(job["connection_id"])
        return await ex.listdir(job["remote_dir"], depth)

    async def fetch_results(self, job_id: str, include_large: bool = False) -> dict[str, Any]:
        """Download new/changed output files to the local cache and refresh the job summary."""
        job = self._load(job_id, with_inputs=True)
        if not job["remote_dir"]:
            raise JobError("job has no remote directory")
        ex = await get_executor(job["connection_id"])
        size_cap = load_settings().max_download_mb * 1024 * 1024
        dest = self.local_dir(job_id)
        fetched, skipped = [], []
        for entry in await ex.listdir(job["remote_dir"], 4):
            rel = entry["path"]
            if entry["is_dir"] or not wanted(rel):
                continue
            if entry["size"] > size_cap and not include_large:
                skipped.append({"path": rel, "size": entry["size"]})
                continue
            local = dest / rel
            up_to_date = (
                local.exists() and local.stat().st_size == entry["size"] and local.stat().st_mtime >= entry["mtime"]
            )
            if not up_to_date:
                await ex.download(_join(ex, job["remote_dir"], rel), local)
            fetched.append(rel)
        analysis = await asyncio.to_thread(analyze_job, dest, job["steps"], job["workflow"])
        summary = {**job["summary"], **brief_summary(analysis), "skipped_large": skipped}
        summary.pop("fetch_error", None)
        self._update(job_id, fetched=1, summary=summary)
        return {"files": fetched, "skipped": skipped}

    async def tail(self, job_id: str, step: int | None, offset: int, max_bytes: int = 256 * 1024) -> dict[str, Any]:
        """Next chunk (from byte ``offset``) of a step's output; whole lines only when truncated."""
        job = self._load(job_id)
        index = (step or job["current_step"] or 1) - 1
        if not job["steps"] or not job["remote_dir"]:
            return {"data": "", "offset": offset, "step": index + 1, "status": job["status"]}
        index = max(0, min(index, len(job["steps"]) - 1))
        st = job["steps"][index]
        rel = posixpath.join(st.get("cwd") or ".", st["output_name"])
        local = self.local_dir(job_id) / rel
        if job["status"] in FINAL and local.exists():
            with open(local, "rb") as fh:
                fh.seek(offset)
                data = fh.read(max_bytes)
        else:
            try:
                ex = await get_executor(job["connection_id"])
                data = await ex.read_file(_join(ex, job["remote_dir"], rel), offset, max_bytes)
            except FileNotFoundError:
                data = b""
        cut = data.rfind(b"\n") + 1 if len(data) == max_bytes else len(data)
        chunk = data[: cut or len(data)]
        return {
            "data": chunk.decode("utf-8", errors="replace"),
            "offset": offset + len(chunk),
            "step": index + 1,
            "status": job["status"],
            "current_step": job["current_step"],
        }


manager = JobManager()

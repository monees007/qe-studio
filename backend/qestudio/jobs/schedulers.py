"""Batch-system adapters: how a job is started, queried and cancelled on a target.

Each adapter only issues shell commands through an :class:`Executor`; adding another
scheduler (LSF, SGE, ...) means adding one class and registering it in ``SCHEDULERS``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..executors.base import Executor, ExecutorError, q
from ..executors.local import IS_WINDOWS, LocalExecutor
from .inputs import JobError

RUNNER_LOG = ".qes/runner.log"


@dataclass
class Submission:
    remote_id: str  # PID (direct) or scheduler job id
    status: str  # "running" or "queued"


class Scheduler:
    name = "base"

    async def submit(self, ex: Executor, job_dir: str, runner: str, login_shell: bool) -> Submission:
        raise NotImplementedError

    async def queue_state(self, ex: Executor, remote_id: str) -> tuple[str | None, str]:
        """(state while queued/running, or None when the job left the queue; detail text)."""
        return None, ""

    async def cancel(self, ex: Executor, remote_id: str, runner_pid: str | None) -> None:
        raise NotImplementedError


class DirectScheduler(Scheduler):
    """Run the runner script directly (detached) on the target."""

    name = "direct"

    async def submit(self, ex: Executor, job_dir: str, runner: str, login_shell: bool) -> Submission:
        if runner.endswith(".py"):
            import sys

            argv = [sys.executable, runner]
        else:
            argv = ["bash", "-l", runner] if login_shell else ["bash", runner]
        pid = await ex.launch_detached(job_dir, argv, RUNNER_LOG)
        return Submission(str(pid or ""), "running")

    async def cancel(self, ex: Executor, remote_id: str, runner_pid: str | None) -> None:
        pid = runner_pid or remote_id
        if not pid or not pid.isdigit():
            return
        if isinstance(ex, LocalExecutor) and IS_WINDOWS and not ex.posix:
            await ex.run(f"taskkill /PID {pid} /T /F", 30)
            return
        # the runner is a session leader: signal its whole process group first
        await ex.run_marked(f"kill -TERM -- -{pid} 2>/dev/null || kill -TERM {pid} 2>/dev/null; true", 30)


class SlurmScheduler(Scheduler):
    name = "slurm"

    async def submit(self, ex: Executor, job_dir: str, runner: str, login_shell: bool) -> Submission:
        r = await ex.run_marked(f"cd {q(job_dir)} && sbatch --parsable {q(runner)}", 60)
        m = re.search(r"(\d+)", r.stdout)
        if not r.ok or not m:
            raise JobError(f"sbatch failed: {(r.stderr or r.stdout).strip()[:500]}")
        return Submission(m.group(1), "queued")

    async def queue_state(self, ex: Executor, remote_id: str) -> tuple[str | None, str]:
        r = await ex.run_marked(f"squeue -h -j {q(remote_id)} -o %T 2>/dev/null", 60)
        lines = [x.strip() for x in r.stdout.splitlines() if x.strip()]
        if lines:
            return lines[0].upper(), ""
        r = await ex.run_marked(f"sacct -n -X -j {q(remote_id)} -o State,ExitCode,Reason 2>/dev/null | head -1", 60)
        return None, r.stdout.strip()

    async def cancel(self, ex: Executor, remote_id: str, runner_pid: str | None) -> None:
        if remote_id:
            await ex.run_marked(f"scancel {q(remote_id)}", 60)


class PbsScheduler(Scheduler):
    name = "pbs"

    async def submit(self, ex: Executor, job_dir: str, runner: str, login_shell: bool) -> Submission:
        r = await ex.run_marked(f"cd {q(job_dir)} && qsub {q(runner)}", 60)
        lines = [x.strip() for x in r.stdout.splitlines() if x.strip()]
        if not r.ok or not lines:
            raise JobError(f"qsub failed: {(r.stderr or r.stdout).strip()[:500]}")
        return Submission(lines[-1], "queued")

    async def queue_state(self, ex: Executor, remote_id: str) -> tuple[str | None, str]:
        r = await ex.run_marked(f"qstat -f {q(remote_id)} 2>/dev/null | grep -i job_state", 60)
        m = re.search(r"job_state\s*=\s*(\w)", r.stdout)
        if m and m.group(1) not in ("C", "F", "E"):
            return {"Q": "PENDING", "R": "RUNNING", "H": "HELD"}.get(m.group(1), m.group(1)), ""
        return None, r.stdout.strip()

    async def cancel(self, ex: Executor, remote_id: str, runner_pid: str | None) -> None:
        if remote_id:
            await ex.run_marked(f"qdel {q(remote_id)}", 60)


SCHEDULERS: dict[str, Scheduler] = {s.name: s for s in (DirectScheduler(), SlurmScheduler(), PbsScheduler())}


def get_scheduler(name: str) -> Scheduler:
    try:
        return SCHEDULERS[name]
    except KeyError as exc:
        raise ExecutorError(f"unknown scheduler '{name}'") from exc

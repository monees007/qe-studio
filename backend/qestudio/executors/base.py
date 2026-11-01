"""Executor abstraction: run commands and move files on a compute target."""

from __future__ import annotations

import abc
import asyncio
import logging
import posixpath
import re
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

MARK_B = "__QES_BEGIN__"
MARK_E = "__QES_END__"


class ExecutorError(RuntimeError):
    """Raised for connection / transport problems (message is user-facing)."""


class OutcomeUnknownError(ExecutorError):
    """The connection dropped while a command with side effects was running: it may or may not
    have taken effect, so callers must check (never blindly re-run, e.g. a job launch)."""


@dataclass
class CmdResult:
    stdout: str
    stderr: str
    code: int

    @property
    def ok(self) -> bool:
        return self.code == 0


def q(s: str) -> str:
    """Shell-quote for POSIX sh."""
    return shlex.quote(s)


def strip_marked(text: str) -> tuple[str, int | None]:
    """Extract the text between the begin/end markers (protects against login-shell banners).

    Returns (body, exit code); the code is None when the end marker is missing.
    """
    start = text.find(MARK_B)
    if start < 0:
        return text, None
    body = text[start + len(MARK_B) :].lstrip("\n")
    m = re.search(re.escape(MARK_E) + r"(-?\d+)", body)
    if not m:
        return body, None
    return body[: m.start()], int(m.group(1))


class Executor(abc.ABC):
    kind: str = "base"
    posix: bool = True

    def __init__(self, conn_id: str, config: dict[str, Any]):
        self.conn_id = conn_id
        self.config = dict(config or {})
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------- lifecycle
    @abc.abstractmethod
    async def connect(self) -> None: ...

    @abc.abstractmethod
    async def close(self) -> None: ...

    # ------------------------------------------------------------- primitives
    @abc.abstractmethod
    async def run(self, cmd: str, timeout: float = 120.0) -> CmdResult:
        """Run a shell command (sh/bash -c semantics) and wait for it."""

    @abc.abstractmethod
    async def write_file(self, path: str, data: bytes, mode: int | None = None) -> None: ...

    @abc.abstractmethod
    async def read_file(self, path: str, offset: int = 0, length: int | None = None) -> bytes: ...

    @abc.abstractmethod
    async def listdir(self, path: str, max_depth: int = 1) -> list[dict[str, Any]]:
        """[{path (relative), size, mtime, is_dir}]"""

    async def download(self, path: str, local: Path, max_bytes: int | None = None) -> int:
        """Default implementation via chunked read_file."""
        local.parent.mkdir(parents=True, exist_ok=True)
        tmp = local.with_suffix(local.suffix + ".part")
        total = 0
        chunk = 4 * 1024 * 1024
        with open(tmp, "wb") as fh:
            while True:
                data = await self.read_file(path, total, chunk)
                if not data:
                    break
                fh.write(data)
                total += len(data)
                if max_bytes is not None and total >= max_bytes:
                    break
                if len(data) < chunk:
                    break
        tmp.replace(local)
        return total

    async def home(self) -> str:
        r = await self.run_marked('printf "%s" "$HOME"')
        return r.stdout.strip() or "/tmp"

    # ------------------------------------------------------------- helpers
    async def run_marked(self, cmd: str, timeout: float = 120.0) -> CmdResult:
        """Run with begin/end markers so shell banners never pollute parsed output."""
        # the command runs in a subshell so that 'exit' inside it cannot skip the end marker
        wrapped = f"echo {MARK_B}; ( {cmd}\n); __rc=$?; echo; echo {MARK_E}$__rc"
        r = await self.run(wrapped, timeout)
        body, rc = strip_marked(r.stdout)
        if body.endswith("\n"):
            body = body[:-1]
        return CmdResult(body, r.stderr, rc if rc is not None else r.code)

    async def mkdir(self, path: str) -> None:
        r = await self.run_marked(f"mkdir -p {q(path)}")
        if not r.ok:
            raise ExecutorError(f"cannot create directory {path}: {r.stderr.strip() or r.stdout.strip()}")

    async def remove_tree(self, path: str) -> None:
        if not path or path in ("/", "~") or len(path) < 6:
            raise ExecutorError(f"refusing to delete suspicious path '{path}'")
        await self.run_marked(f"rm -rf -- {q(path)}")

    async def expand(self, path: str) -> str:
        if path.startswith("~"):
            h = await self.home()
            return posixpath.normpath(h + path[1:])
        if not path.startswith("/"):
            h = await self.home()
            return posixpath.normpath(posixpath.join(h, path))
        return posixpath.normpath(path)

    async def exists(self, path: str) -> bool:
        r = await self.run_marked(f"test -e {q(path)} && echo yes || echo no")
        return r.stdout.strip().endswith("yes")

    # ------------------------------------------------------------- process control
    async def launch_detached(self, workdir: str, argv: list[str], log_path: str) -> int | None:
        """Start ``argv`` in ``workdir`` fully detached from this connection.

        The process gets its own session and has stdin/stdout/stderr redirected, so it
        survives disconnects. Returns the PID when the executor knows it (the runner also
        writes its own PID to ``.qes/pid``).

        Only *simple* commands are backgrounded: bash keeps saved copies of the caller's
        stdout when a backgrounded subshell/compound command carries redirections, which
        would make this call block until the job ends.
        """
        cmd = " ".join(q(a) for a in argv)
        redir = f"> {q(log_path)} 2>&1 < /dev/null &"
        script = (
            f"cd {q(workdir)} || exit 1\n"
            f"if command -v setsid >/dev/null 2>&1; then setsid nohup {cmd} {redir}\n"
            f"else nohup {cmd} {redir}\nfi\n"
        )
        r = await self.run(script, 60)
        if r.code != 0:
            raise ExecutorError(f"launch failed: {(r.stderr or r.stdout).strip()[:500]}")
        return None

    async def pid_alive(self, pid: int) -> bool:
        """True if the process exists and is not a zombie."""
        r = await self.run_marked(
            f"if kill -0 {int(pid)} 2>/dev/null; then s=$(ps -o stat= -p {int(pid)} 2>/dev/null); "
            f'case "$s" in Z*) echo dead;; *) echo alive;; esac; else echo dead; fi',
            30,
        )
        return r.stdout.strip().endswith("alive")

    async def read_small_files(self, directory: str, names: list[str]) -> dict[str, str]:
        """Read several small text files of one directory in a single round trip."""
        listing = " ".join(q(n) for n in names)
        cmd = (
            f"cd {q(directory)} 2>/dev/null && for f in {listing}; "
            'do [ -f "$f" ] && printf \'%s=%s\\n\' "$f" "$(head -c 4096 "$f")"; done; true'
        )
        r = await self.run_marked(cmd, 60)
        out: dict[str, str] = {}
        for ln in r.stdout.splitlines():
            if "=" in ln:
                k, v = ln.split("=", 1)
                out[k.strip()] = v.strip()
        return out

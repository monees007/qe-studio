"""Local machine executor (the computer running the backend)."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, ClassVar

from .base import CmdResult, Executor, ExecutorError

IS_WINDOWS = sys.platform.startswith("win")


def _shell() -> list[str]:
    if IS_WINDOWS:
        bash = shutil.which("bash")  # Git-Bash / WSL bash if present
        return [bash, "-c"] if bash else ["cmd.exe", "/c"]
    return [shutil.which("bash") or "/bin/sh", "-c"]


class LocalExecutor(Executor):
    kind = "local"

    def __init__(self, conn_id: str, config: dict[str, Any]):
        super().__init__(conn_id, config)
        self.posix = not IS_WINDOWS or bool(shutil.which("bash"))

    async def connect(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def run(self, cmd: str, timeout: float = 120.0) -> CmdResult:
        argv = [*_shell(), cmd]
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                start_new_session=not IS_WINDOWS,
            )
        except OSError as exc:
            raise ExecutorError(f"cannot start local shell: {exc}") from exc
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            raise ExecutorError(f"local command timed out after {timeout:.0f}s") from None
        return CmdResult(out.decode(errors="replace"), err.decode(errors="replace"), proc.returncode or 0)

    async def write_file(self, path: str, data: bytes, mode: int | None = None) -> None:
        def _w() -> None:
            p = Path(os.path.expanduser(path))
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".qes-tmp")
            tmp.write_bytes(data)
            if mode is not None and not IS_WINDOWS:
                os.chmod(tmp, mode)
            os.replace(tmp, p)

        await asyncio.to_thread(_w)

    async def read_file(self, path: str, offset: int = 0, length: int | None = None) -> bytes:
        def _r() -> bytes:
            p = Path(os.path.expanduser(path))
            if not p.exists():
                raise FileNotFoundError(path)
            with open(p, "rb") as fh:
                fh.seek(offset)
                return fh.read(length) if length is not None else fh.read()

        return await asyncio.to_thread(_r)

    async def download(self, path: str, local: Path, max_bytes: int | None = None) -> int:
        def _c() -> int:
            src = Path(os.path.expanduser(path))
            local.parent.mkdir(parents=True, exist_ok=True)
            if max_bytes is not None and src.stat().st_size > max_bytes:
                with open(src, "rb") as fi, open(local, "wb") as fo:
                    fo.write(fi.read(max_bytes))
                return max_bytes
            shutil.copyfile(src, local)
            return src.stat().st_size

        return await asyncio.to_thread(_c)

    async def listdir(self, path: str, max_depth: int = 1) -> list[dict[str, Any]]:
        def _l() -> list[dict[str, Any]]:
            root = Path(os.path.expanduser(path))
            if not root.exists():
                raise FileNotFoundError(path)
            out = []
            base_depth = len(root.parts)
            for dirpath, dirnames, filenames in os.walk(root):
                depth = len(Path(dirpath).parts) - base_depth
                if depth >= max_depth:
                    dirnames[:] = []
                for d in sorted(dirnames):
                    p = Path(dirpath) / d
                    out.append(
                        {
                            "path": str(p.relative_to(root)).replace("\\", "/"),
                            "size": 0,
                            "mtime": p.stat().st_mtime,
                            "is_dir": True,
                        }
                    )
                for f in sorted(filenames):
                    p = Path(dirpath) / f
                    try:
                        st = p.stat()
                    except OSError:
                        continue
                    out.append(
                        {
                            "path": str(p.relative_to(root)).replace("\\", "/"),
                            "size": st.st_size,
                            "mtime": st.st_mtime,
                            "is_dir": False,
                        }
                    )
                if len(out) > 20000:
                    break
            return out

        return await asyncio.to_thread(_l)

    async def home(self) -> str:
        return str(Path.home())

    async def expand(self, path: str) -> str:
        p = Path(os.path.expanduser(path))
        if not p.is_absolute():
            p = Path.home() / p
        return str(p.resolve()) if p.exists() else str(p)

    async def mkdir(self, path: str) -> None:
        await asyncio.to_thread(lambda: Path(os.path.expanduser(path)).mkdir(parents=True, exist_ok=True))

    async def remove_tree(self, path: str) -> None:
        p = Path(os.path.expanduser(path))
        if len(p.parts) < 3:
            raise ExecutorError(f"refusing to delete suspicious path '{path}'")
        await asyncio.to_thread(shutil.rmtree, p, True)

    async def exists(self, path: str) -> bool:
        return Path(os.path.expanduser(path)).exists()

    # ------------------------------------------------------------- process control
    # Launch through subprocess.Popen rather than a shell: under uvloop (uvicorn[standard])
    # child processes of asyncio subprocesses can inherit the parent's pipe sockets, which
    # would tie the runner's lifetime to the launching request.
    _children: ClassVar[list[subprocess.Popen]] = []

    @classmethod
    def reap(cls) -> None:
        """Collect exited children so they do not linger as zombies."""
        cls._children = [p for p in cls._children if p.poll() is None]

    async def launch_detached(self, workdir: str, argv: list[str], log_path: str) -> int | None:
        self.reap()
        log_file = Path(os.path.expanduser(workdir)) / log_path
        log_file.parent.mkdir(parents=True, exist_ok=True)
        kwargs: dict[str, Any] = {
            "cwd": os.path.expanduser(workdir),
            "stdin": subprocess.DEVNULL,
            "stderr": subprocess.STDOUT,
            "close_fds": True,
        }
        if IS_WINDOWS:
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200) | getattr(
                subprocess, "DETACHED_PROCESS", 0x8
            )
        else:
            kwargs["start_new_session"] = True
        with open(log_file, "ab") as logf:
            try:
                proc = subprocess.Popen(argv, stdout=logf, **kwargs)
            except OSError as exc:
                raise ExecutorError(f"cannot start {argv[0]}: {exc}") from exc
        self._children.append(proc)
        return proc.pid

    async def pid_alive(self, pid: int) -> bool:
        self.reap()
        if IS_WINDOWS:
            r = await self.run(f'tasklist /FI "PID eq {int(pid)}" /NH', 30)
            return str(pid) in r.stdout
        try:
            os.kill(int(pid), 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        try:  # zombie check (Linux); other platforms fall back to "alive"
            with open(f"/proc/{int(pid)}/stat") as fh:
                return fh.read().split(")")[-1].split()[0] != "Z"
        except OSError:
            return True

    async def read_small_files(self, directory: str, names: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        base = Path(os.path.expanduser(directory))
        for n in names:
            p = base / n
            if p.is_file():
                try:
                    out[n] = p.read_text(errors="replace")[:4096].strip()
                except OSError:
                    pass
        return out

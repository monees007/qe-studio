"""Jupyter-server executor: Kaggle ('Run > Kaggle Jupyter Server' VS Code URL), JupyterLab,
JupyterHub single-user servers, Colab local runtimes...

Everything (commands and file transfer) goes through a dedicated Python kernel that this
backend creates over the Jupyter REST API and drives over the kernel WebSocket using the
standard JSON message protocol. Jobs started from the kernel are detached
(start_new_session) so they keep running if the kernel or this backend restarts.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
from websockets.asyncio.client import ClientConnection
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from .base import CmdResult, Executor, ExecutorError, OutcomeUnknownError

log = logging.getLogger(__name__)
CHUNK = 512 * 1024  # raw bytes per transfer message (~700 kB base64)
# With no kernel message for this long, ask the REST API whether the kernel still exists:
# a deleted/culled kernel (Kaggle session restart) leaves the websocket open but silent.
PROBE_FIRST_S = 3.0
PROBE_EVERY_S = 10.0


class _KernelLost(Exception):
    """The kernel or its websocket went away. `started` is True when the kernel had already
    begun executing our request, i.e. its side effects may have happened."""

    def __init__(self, reason: str, started: bool):
        super().__init__(reason)
        self.started = started


def parse_jupyter_url(url: str, token: str | None = None) -> tuple[str, str | None]:
    """Return (base_url, token).

    Accepts: https://host/lab?token=T, https://host/user/x/tree?token=T,
    https://kkb-production.jupyter-proxy.kaggle.net/k/<id>/<token>/proxy (Kaggle VS Code URL).
    """
    url = url.strip()
    if not re.match(r"^https?://", url):
        raise ExecutorError("Jupyter URL must start with http:// or https://")
    p = urlparse(url)
    qs = parse_qs(p.query)
    tok = token or (qs.get("token") or [None])[0]
    path = p.path.rstrip("/")
    segs = path.split("/")
    # Kaggle: /k/<id>/<token>/proxy  (token embedded in the path)
    if len(segs) >= 5 and segs[1] == "k" and segs[-1] == "proxy":
        tok = tok or segs[-2]
    else:
        path = re.sub(r"/(lab|tree|notebooks|edit|voila|doc)(/.*)?$", "", path)
    base = urlunparse((p.scheme, p.netloc, path, "", "", ""))
    return base.rstrip("/"), tok


def _code_literal(b: bytes) -> str:
    return repr(base64.b64encode(b).decode())


class JupyterExecutor(Executor):
    kind = "jupyter"

    def __init__(self, conn_id: str, config: dict[str, Any], url: str, token: str | None = None):
        super().__init__(conn_id, config)
        self.base, self.token = parse_jupyter_url(url, token)
        self._http: httpx.AsyncClient | None = None
        self._ws: ClientConnection | None = None
        self.kernel_id: str | None = config.get("_kernel_id")
        self.session = uuid.uuid4().hex
        self._exec_lock = asyncio.Lock()
        self._xsrf: str | None = None

    # ------------------------------------------------------------- REST
    def _headers(self) -> dict[str, str]:
        h = {"Accept": "application/json"}
        if self.token:
            h["Authorization"] = f"token {self.token}"
        if self._xsrf:
            h["X-XSRFToken"] = self._xsrf
        return h

    def _params(self) -> dict[str, str]:
        return {"token": self.token} if self.token else {}

    async def _client(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                timeout=httpx.Timeout(30.0, connect=20.0), follow_redirects=True, trust_env=True
            )
        return self._http

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        cli = await self._client()
        url = f"{self.base}/{path.lstrip('/')}"
        try:
            r = await cli.request(method, url, headers=self._headers(), params=self._params(), **kw)
            if r.status_code == 403 and self._xsrf is None and method != "GET":
                # some servers insist on XSRF even with token auth
                g = await cli.get(f"{self.base}/", headers=self._headers(), params=self._params())
                self._xsrf = g.cookies.get("_xsrf") or cli.cookies.get("_xsrf")
                if self._xsrf:
                    r = await cli.request(method, url, headers=self._headers(), params=self._params(), **kw)
        except httpx.HTTPError as exc:
            raise ExecutorError(f"cannot reach Jupyter server: {exc}") from exc
        if r.status_code in (401, 403):
            raise ExecutorError(
                "Jupyter server rejected the token (401/403). For Kaggle, copy a fresh "
                "'VS Code Compatible URL' from Run > Kaggle Jupyter Server."
            )
        if r.status_code == 404 and path.startswith("api/kernels/"):
            return r
        if r.status_code >= 400:
            raise ExecutorError(f"Jupyter API {method} {path} failed: HTTP {r.status_code} {r.text[:200]}")
        return r

    async def _kernel_alive(self) -> bool:
        if not self.kernel_id:
            return False
        r = await self._request("GET", f"api/kernels/{self.kernel_id}")
        return r.status_code == 200 and r.json().get("execution_state") != "dead"

    async def _start_kernel(self) -> None:
        r = await self._request("POST", "api/kernels", json={"name": self.config.get("kernel_name", "python3")})
        self.kernel_id = r.json()["id"]
        log.info("started Jupyter kernel %s on %s", self.kernel_id, self.base)

    # ------------------------------------------------------------- websocket
    def _ws_url(self) -> str:
        p = urlparse(self.base)
        scheme = "wss" if p.scheme == "https" else "ws"
        q = {"session_id": self.session}
        if self.token:
            q["token"] = self.token
        return urlunparse((scheme, p.netloc, f"{p.path}/api/kernels/{self.kernel_id}/channels", "", urlencode(q), ""))

    async def _open_ws(self) -> None:
        headers = {}
        if self.token:
            headers["Authorization"] = f"token {self.token}"
        if self._xsrf:
            headers["Cookie"] = f"_xsrf={self._xsrf}"
        try:
            self._ws = await ws_connect(
                self._ws_url(),
                additional_headers=headers,
                max_size=64 * 1024 * 1024,
                ping_interval=20,
                ping_timeout=60,
                open_timeout=30,
                compression=None,
                origin=None,
            )
        except Exception as exc:
            raise ExecutorError(f"cannot open kernel websocket: {exc}") from exc

    async def connect(self) -> None:
        async with self._lock:
            if self._ws is not None and self._ws.state.name == "OPEN":
                return
            if not await self._kernel_alive():
                await self._start_kernel()
            await self._open_ws()
            try:  # sanity check: the kernel answers
                await self._execute("import os, sys, json, base64, subprocess, shutil", timeout=60)
            except _KernelLost as exc:
                await self._drop_ws()
                raise ExecutorError(f"Jupyter kernel is not responding: {exc}") from exc

    async def _drop_ws(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:
                pass
        self._ws = None

    async def close(self, shutdown_kernel: bool = False) -> None:
        await self._drop_ws()
        if shutdown_kernel and self.kernel_id:
            try:
                await self._request("DELETE", f"api/kernels/{self.kernel_id}")
            except Exception:
                pass
            self.kernel_id = None
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def _execute(self, code: str, timeout: float = 120.0) -> tuple[str, str, dict[str, Any] | None]:
        """Execute code in the kernel; return (stdout, stderr, error)."""
        if self._ws is None:
            await self.connect()
        assert self._ws is not None
        msg_id = uuid.uuid4().hex
        msg = {
            "header": {
                "msg_id": msg_id,
                "username": "qestudio",
                "session": self.session,
                "msg_type": "execute_request",
                "version": "5.3",
                "date": datetime.now(timezone.utc).isoformat(),
            },
            "parent_header": {},
            "metadata": {},
            "channel": "shell",
            "buffers": [],
            "content": {
                "code": code,
                "silent": False,
                "store_history": False,
                "user_expressions": {},
                "allow_stdin": False,
                "stop_on_error": True,
            },
        }
        out: list[str] = []
        err: list[str] = []
        error: dict[str, Any] | None = None
        got_reply = got_idle = False
        started = False  # any message about our request seen -> the kernel picked it up
        try:
            await self._ws.send(json.dumps(msg))
        except (ConnectionClosed, OSError) as exc:
            raise _KernelLost(f"websocket closed: {exc}", started=False) from exc
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        quiet_limit = PROBE_FIRST_S
        while not (got_reply and got_idle):
            remaining = deadline - loop.time()
            if remaining <= 0:
                await self._interrupt()
                raise ExecutorError(f"kernel execution timed out after {timeout:.0f}s")
            try:
                raw = await asyncio.wait_for(self._ws.recv(), min(remaining, quiet_limit))
            except asyncio.TimeoutError:
                if loop.time() < deadline and not await self._kernel_alive():
                    raise _KernelLost("the kernel no longer exists", started) from None
                quiet_limit = PROBE_EVERY_S
                continue
            except (ConnectionClosed, OSError) as exc:
                raise _KernelLost(f"websocket closed: {exc}", started) from exc
            if isinstance(raw, bytes):
                continue  # binary (v1 protocol) frames are not used by us
            m = json.loads(raw)
            t = m.get("msg_type") or m.get("header", {}).get("msg_type")
            c = m.get("content", {})
            if t == "status" and c.get("execution_state") in ("dead", "restarting"):
                # sent by the server (no parent) when the kernel died or is being auto-restarted
                raise _KernelLost(f"kernel {c.get('execution_state')}", started)
            if (m.get("parent_header") or {}).get("msg_id") != msg_id:
                continue
            started = True
            if t == "stream":
                (out if c.get("name") == "stdout" else err).append(c.get("text", ""))
            elif t == "error":
                error = {
                    "ename": c.get("ename"),
                    "evalue": c.get("evalue"),
                    "traceback": "\n".join(re.sub(r"\x1b\[[0-9;]*m", "", x) for x in c.get("traceback", [])),
                }
            elif t == "execute_reply":
                got_reply = True
                if c.get("status") == "error" and error is None:
                    error = {"ename": c.get("ename"), "evalue": c.get("evalue"), "traceback": ""}
            elif t == "status" and c.get("execution_state") == "idle":
                got_idle = True
        return "".join(out), "".join(err), error

    async def _interrupt(self) -> None:
        try:
            await self._request("POST", f"api/kernels/{self.kernel_id}/interrupt")
        except Exception:
            pass

    async def execute(
        self, code: str, timeout: float = 120.0, idempotent: bool = True
    ) -> tuple[str, str, dict[str, Any] | None]:
        """Execute with one transparent reconnect (new kernel if the old one is gone).

        The request is re-sent only when that is safe: it never reached the kernel, or it is
        `idempotent`. Otherwise (e.g. a job launch) the error says the outcome is unknown, so a
        job is never started twice.
        """
        async with self._exec_lock:
            for attempt in (1, 2):
                try:
                    return await self._execute(code, timeout)
                except _KernelLost as exc:
                    log.info("Jupyter kernel connection lost (%s); reconnecting", exc)
                    await self._drop_ws()
                    if attempt == 2:
                        raise ExecutorError(f"lost connection to the Jupyter kernel: {exc}") from exc
                    if exc.started and not idempotent:
                        raise OutcomeUnknownError(
                            f"lost connection to the Jupyter kernel while a command was running ({exc}); "
                            "its outcome is unknown"
                        ) from exc
                    await self.connect()
        raise ExecutorError("unreachable")

    async def _pycall(self, code: str, timeout: float = 120.0, idempotent: bool = True) -> Any:
        """Run python code that prints one '__QES__<json>' line; return the decoded object."""
        o, e, error = await self.execute(code, timeout, idempotent)
        if error:
            if error.get("ename") == "FileNotFoundError":
                raise FileNotFoundError(error.get("evalue"))
            raise ExecutorError(f"{error.get('ename')}: {error.get('evalue')}")
        m = re.search(r"__QES__(.*)", o)
        if not m:
            raise ExecutorError(f"unexpected kernel output: {(o + e)[:300]}")
        return json.loads(m.group(1))

    # ------------------------------------------------------------- primitives
    async def run(self, cmd: str, timeout: float = 120.0) -> CmdResult:
        shell = "bash" if self.config.get("shell", "bash") == "bash" else "sh"
        flag = "-lc" if self.config.get("login_shell") else "-c"
        code = (
            "import subprocess, json, base64, shutil\n"
            f"_sh = shutil.which({shell!r}) or '/bin/sh'\n"
            f"try:\n"
            f"    _r = subprocess.run([_sh, {flag!r}, {cmd!r}], capture_output=True, timeout={float(timeout)!r}, stdin=subprocess.DEVNULL)\n"
            "    _o = {'o': base64.b64encode(_r.stdout).decode(), 'e': base64.b64encode(_r.stderr).decode(), 'c': _r.returncode}\n"
            "except subprocess.TimeoutExpired as _x:\n"
            "    _o = {'o': '', 'e': base64.b64encode(b'timeout').decode(), 'c': 124}\n"
            "print('__QES__' + json.dumps(_o))\n"
        )
        # shell commands may have side effects (sbatch, rm ...): never silently re-run them
        d = await self._pycall(code, timeout + 30, idempotent=False)
        return CmdResult(
            base64.b64decode(d["o"]).decode(errors="replace"),
            base64.b64decode(d["e"]).decode(errors="replace"),
            int(d["c"]),
        )

    async def write_file(self, path: str, data: bytes, mode: int | None = None) -> None:
        tmp = path + ".qes-tmp"
        pos = 0
        first = True
        while first or pos < len(data):
            chunk = data[pos : pos + CHUNK]
            # positional write + truncate: re-sending a chunk after a reconnect is harmless
            code = (
                "import os, base64, json\n"
                f"_p = os.path.expanduser({tmp!r})\n"
                "os.makedirs(os.path.dirname(_p) or '.', exist_ok=True)\n"
                f"with open(_p, {'wb' if first else 'r+b'!r}) as _f:\n"
                f"    _f.seek({pos}); _f.write(base64.b64decode({_code_literal(chunk)})); _f.truncate()\n"
                "print('__QES__' + json.dumps(os.path.getsize(_p)))\n"
            )
            await self._pycall(code, 300)
            pos += len(chunk)
            first = False
        mode_code = f"os.chmod(_p, {mode!r})\n" if mode is not None else ""
        await self._pycall(
            "import os, json\n"
            f"_p = os.path.expanduser({tmp!r})\n"
            + mode_code
            + f"os.replace(_p, os.path.expanduser({path!r}))\nprint('__QES__true')\n",
            60,
        )

    async def read_file(self, path: str, offset: int = 0, length: int | None = None) -> bytes:
        if length is None:
            out = b""
            while True:
                part = await self.read_file(path, offset + len(out), CHUNK)
                out += part
                if len(part) < CHUNK:
                    return out
        n = min(length, CHUNK)
        code = (
            "import os, base64, json\n"
            f"with open(os.path.expanduser({path!r}), 'rb') as _f:\n"
            f"    _f.seek({int(offset)})\n"
            f"    _d = _f.read({int(n)})\n"
            "print('__QES__' + json.dumps(base64.b64encode(_d).decode()))\n"
        )
        data = base64.b64decode(await self._pycall(code, 300))
        if length > n and len(data) == n:
            data += await self.read_file(path, offset + n, length - n)
        return data

    async def download(self, path: str, local: Path, max_bytes: int | None = None) -> int:
        local.parent.mkdir(parents=True, exist_ok=True)
        tmp = local.with_suffix(local.suffix + ".part")
        total = 0
        with open(tmp, "wb") as fh:
            while True:
                part = await self.read_file(path, total, CHUNK)
                fh.write(part)
                total += len(part)
                if len(part) < CHUNK or (max_bytes is not None and total >= max_bytes):
                    break
        tmp.replace(local)
        return total

    async def listdir(self, path: str, max_depth: int = 1) -> list[dict[str, Any]]:
        code = (
            "import os, json\n"
            f"_root = os.path.expanduser({path!r})\n"
            "if not os.path.exists(_root): raise FileNotFoundError(_root)\n"
            "_out = []\n"
            "_bd = _root.rstrip('/').count('/')\n"
            "for _dp, _dn, _fn in os.walk(_root):\n"
            f"    if _dp.rstrip('/').count('/') - _bd + 1 >= {int(max_depth)}: _dn[:] = []\n"
            "    for _n in sorted(_dn):\n"
            "        _p = os.path.join(_dp, _n); _out.append({'path': os.path.relpath(_p, _root), 'size': 0, 'mtime': os.path.getmtime(_p), 'is_dir': True})\n"
            "    for _n in sorted(_fn):\n"
            "        _p = os.path.join(_dp, _n)\n"
            "        try: _s = os.stat(_p)\n"
            "        except OSError: continue\n"
            "        _out.append({'path': os.path.relpath(_p, _root), 'size': _s.st_size, 'mtime': _s.st_mtime, 'is_dir': False})\n"
            "    if len(_out) > 20000: break\n"
            "print('__QES__' + json.dumps(_out))\n"
        )
        return await self._pycall(code, 120)

    async def home(self) -> str:
        return await self._pycall("import os, json\nprint('__QES__' + json.dumps(os.path.expanduser('~')))\n", 60)

    async def launch_detached(self, workdir: str, argv: list[str], log_path: str) -> int | None:
        """Popen inside the kernel (own session, closed fds); children are kept for reaping."""
        code = (
            "import subprocess, os, json\n"
            "_qes_children = globals().setdefault('_qes_children', [])\n"
            "_qes_children[:] = [p for p in _qes_children if p.poll() is None]\n"
            f"_wd = os.path.expanduser({workdir!r})\n"
            f"_lp = os.path.join(_wd, {log_path!r})\n"
            "os.makedirs(os.path.dirname(_lp), exist_ok=True)\n"
            "with open(_lp, 'ab') as _log:\n"
            f"    _p = subprocess.Popen({argv!r}, cwd=_wd, stdout=_log, stderr=subprocess.STDOUT,"
            " stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)\n"
            "_qes_children.append(_p)\n"
            "print('__QES__' + json.dumps(_p.pid))\n"
        )
        return int(await self._pycall(code, 60, idempotent=False))

    async def pid_alive(self, pid: int) -> bool:
        code = (
            "import os, json\n"
            "for _c in globals().get('_qes_children', []): _c.poll()\n"
            "def _alive(p):\n"
            "    try: os.kill(p, 0)\n"
            "    except ProcessLookupError: return False\n"
            "    except PermissionError: return True\n"
            "    try:\n"
            "        with open(f'/proc/{p}/stat') as fh: return fh.read().split(')')[-1].split()[0] != 'Z'\n"
            "    except OSError: return True\n"
            f"print('__QES__' + json.dumps(_alive({int(pid)})))\n"
        )
        return bool(await self._pycall(code, 60))

    async def read_small_files(self, directory: str, names: list[str]) -> dict[str, str]:
        code = (
            "import os, json\n"
            f"_d = os.path.expanduser({directory!r})\n"
            "_o = {}\n"
            f"for _n in {names!r}:\n"
            "    _p = os.path.join(_d, _n)\n"
            "    if os.path.isfile(_p):\n"
            "        with open(_p, errors='replace') as _f: _o[_n] = _f.read(4096).strip()\n"
            "print('__QES__' + json.dumps(_o))\n"
        )
        return await self._pycall(code, 60)

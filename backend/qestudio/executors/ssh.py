"""SSH executor (asyncssh): persistent connection, SFTP transfers, jump hosts, TOFU host keys."""

from __future__ import annotations

import asyncio
import logging
import os
import posixpath
from pathlib import Path
from typing import Any

import asyncssh

from ..config import get_env
from ..secrets_store import get_secret
from .base import CmdResult, Executor, ExecutorError, q

log = logging.getLogger(__name__)


def _parse_hostspec(spec: str, default_user: str | None) -> tuple[str, int, str | None]:
    user = default_user
    host = spec.strip()
    port = 22
    if "@" in host:
        user, host = host.split("@", 1)
    if host.count(":") == 1:
        host, p = host.split(":")
        port = int(p)
    return host, port, user


class SSHExecutor(Executor):
    kind = "ssh"

    def __init__(self, conn_id: str, config: dict[str, Any]):
        super().__init__(conn_id, config)
        self._conn: asyncssh.SSHClientConnection | None = None
        self._jump: asyncssh.SSHClientConnection | None = None
        self._sftp: asyncssh.SFTPClient | None = None
        self._connect_lock = asyncio.Lock()
        self.host_key_fingerprint: str | None = None
        self.host_key_new = False

    # ------------------------------------------------------------- connection
    def _known_hosts_files(self) -> list[str]:
        files = [str(get_env().known_hosts_path)]
        user_kh = Path.home() / ".ssh" / "known_hosts"
        if user_kh.exists():
            files.append(str(user_kh))
        return [f for f in files if Path(f).exists()]

    def _client_kwargs(self, host: str, user: str | None, port: int, policy: str, known_hosts) -> dict[str, Any]:
        cfg = self.config
        kw: dict[str, Any] = {
            "host": host,
            "port": port,
            "username": user or None,
            "keepalive_interval": int(cfg.get("keepalive", 30)),
            "keepalive_count_max": 4,
            "connect_timeout": float(cfg.get("connect_timeout", 20)),
            "known_hosts": known_hosts,
        }
        auth = cfg.get("auth", "key")
        if auth == "password":
            pw = get_secret(f"ssh:{self.conn_id}:password")
            if not pw:
                raise ExecutorError("no password stored for this connection")
            kw["password"] = pw
            kw["client_keys"] = None
            kw["preferred_auth"] = "password,keyboard-interactive"
        elif auth == "key":
            kp = cfg.get("key_path")
            if kp:
                kp = os.path.expanduser(kp)
                if not os.path.exists(kp):
                    raise ExecutorError(f"private key not found: {kp}")
                kw["client_keys"] = [kp]
            pp = get_secret(f"ssh:{self.conn_id}:passphrase")
            if pp:
                kw["passphrase"] = pp
        # auth == "agent": asyncssh uses SSH_AUTH_SOCK + default keys automatically
        return kw

    async def _open(self, host: str, port: int, user: str | None, tunnel=None) -> asyncssh.SSHClientConnection:
        policy = self.config.get("host_key_policy", "tofu")
        kh_files = self._known_hosts_files()
        kw = self._client_kwargs(host, user, port, policy, kh_files if kh_files else ())
        if tunnel is not None:
            kw["tunnel"] = tunnel
        if policy == "ignore":
            kw["known_hosts"] = None
            return await asyncssh.connect(**kw)
        try:
            return await asyncssh.connect(**kw)
        except asyncssh.HostKeyNotVerifiable as exc:
            if policy != "tofu":
                raise ExecutorError(f"host key for {host} is not trusted (strict policy): {exc}") from exc
            if kh_files and await self._host_known(host, port):
                # the host is known but the key changed -> never auto-accept
                raise ExecutorError(
                    f"HOST KEY MISMATCH for {host}: the server key changed since it was first trusted. "
                    "This can indicate a man-in-the-middle attack. If the change is expected, remove the "
                    f"entry from {get_env().known_hosts_path} and reconnect."
                ) from exc
            kw["known_hosts"] = None
            conn = await asyncssh.connect(**kw)
            key = conn.get_server_host_key()
            if key is not None:
                self._remember_host_key(host, port, key)
            return conn

    async def _host_known(self, host: str, port: int) -> bool:
        name = host if port == 22 else f"[{host}]:{port}"
        for f in self._known_hosts_files():
            try:
                for ln in Path(f).read_text().splitlines():
                    if ln.split(" ", 1)[0].split(",").count(name):
                        return True
            except OSError:
                continue
        return False

    def _remember_host_key(self, host: str, port: int, key: asyncssh.SSHKey) -> None:
        name = host if port == 22 else f"[{host}]:{port}"
        line = f"{name} {key.export_public_key('openssh').decode().strip()}\n"
        p = get_env().known_hosts_path
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a") as fh:
            fh.write(line)
        self.host_key_fingerprint = key.get_fingerprint()
        self.host_key_new = True
        log.info("trusted new host key for %s: %s", name, self.host_key_fingerprint)

    async def connect(self) -> None:
        async with self._connect_lock:
            if self._conn is not None and not self._conn.is_closed():
                return
            cfg = self.config
            host = cfg.get("host")
            if not host:
                raise ExecutorError("SSH host is not set")
            port = int(cfg.get("port") or 22)
            user = cfg.get("username") or None
            try:
                tunnel = None
                if cfg.get("jump_host"):
                    jh, jp, ju = _parse_hostspec(cfg["jump_host"], user)
                    self._jump = await self._open(jh, jp, ju)
                    tunnel = self._jump
                self._conn = await self._open(host, port, user, tunnel)
                key = self._conn.get_server_host_key()
                if key is not None:
                    self.host_key_fingerprint = key.get_fingerprint()
                self._sftp = None
            except ExecutorError:
                raise
            except asyncssh.PermissionDenied as exc:
                raise ExecutorError(f"authentication failed for {user}@{host}: {exc.reason}") from exc
            except asyncssh.DisconnectError as exc:
                raise ExecutorError(f"SSH disconnected: {exc.reason}") from exc
            except (OSError, asyncio.TimeoutError) as exc:
                raise ExecutorError(f"cannot reach {host}:{port}: {exc or 'timeout'}") from exc
            except asyncssh.Error as exc:
                raise ExecutorError(f"SSH error: {exc}") from exc

    async def close(self) -> None:
        for c in (self._conn, self._jump):
            if c is not None:
                c.close()
                try:
                    await asyncio.wait_for(c.wait_closed(), 5)
                except Exception:
                    pass
        self._conn = self._jump = None
        self._sftp = None

    async def _ensure(self) -> asyncssh.SSHClientConnection:
        if self._conn is None or self._conn.is_closed():
            self._conn = None
            await self.connect()
        assert self._conn is not None
        return self._conn

    async def _sftp_client(self) -> asyncssh.SFTPClient:
        conn = await self._ensure()
        if self._sftp is None:
            self._sftp = await conn.start_sftp_client()
        return self._sftp

    async def _retry(self, fn, *args):
        try:
            return await fn(*args)
        except (
            asyncssh.ConnectionLost,
            asyncssh.ChannelOpenError,
            BrokenPipeError,
            ConnectionResetError,
            asyncssh.DisconnectError,
        ):
            log.info("SSH connection lost; reconnecting")
            await self.close()
            return await fn(*args)

    # ------------------------------------------------------------- primitives
    def _wrap(self, cmd: str) -> str:
        if self.config.get("login_shell", True):
            return f"bash -l -c {q(cmd)}"
        return f"sh -c {q(cmd)}"

    async def run(self, cmd: str, timeout: float = 120.0) -> CmdResult:
        async def _do() -> CmdResult:
            conn = await self._ensure()
            r = await conn.run(self._wrap(cmd), check=False, timeout=timeout)
            out = r.stdout if isinstance(r.stdout, str) else (r.stdout or b"").decode(errors="replace")
            err = r.stderr if isinstance(r.stderr, str) else (r.stderr or b"").decode(errors="replace")
            return CmdResult(out or "", err or "", r.exit_status if r.exit_status is not None else -1)

        try:
            return await self._retry(_do)
        except asyncssh.TimeoutError as exc:
            raise ExecutorError(f"remote command timed out after {timeout:.0f}s") from exc
        except asyncssh.Error as exc:
            raise ExecutorError(f"SSH error: {exc}") from exc

    async def write_file(self, path: str, data: bytes, mode: int | None = None) -> None:
        async def _do() -> None:
            sftp = await self._sftp_client()
            d = posixpath.dirname(path)
            if d:
                await sftp.makedirs(d, exist_ok=True)
            tmp = path + ".qes-tmp"
            async with sftp.open(tmp, "wb") as fh:
                await fh.write(data)
            if mode is not None:
                await sftp.chmod(tmp, mode)
            try:
                await sftp.posix_rename(tmp, path)
            except (asyncssh.SFTPOpUnsupported, asyncssh.SFTPError):
                if await sftp.exists(path):
                    await sftp.remove(path)
                await sftp.rename(tmp, path)

        try:
            await self._retry(_do)
        except asyncssh.SFTPError as exc:
            raise ExecutorError(f"cannot write {path}: {exc.reason}") from exc

    async def read_file(self, path: str, offset: int = 0, length: int | None = None) -> bytes:
        async def _do() -> bytes:
            sftp = await self._sftp_client()
            async with sftp.open(path, "rb") as fh:
                if offset:
                    await fh.seek(offset)
                return await fh.read(length if length is not None else -1)

        try:
            return await self._retry(_do)
        except asyncssh.SFTPNoSuchFile as exc:
            raise FileNotFoundError(path) from exc
        except asyncssh.SFTPError as exc:
            raise ExecutorError(f"cannot read {path}: {exc.reason}") from exc

    async def download(self, path: str, local: Path, max_bytes: int | None = None) -> int:
        if max_bytes is not None:
            return await super().download(path, local, max_bytes)

        async def _do() -> int:
            sftp = await self._sftp_client()
            local.parent.mkdir(parents=True, exist_ok=True)
            tmp = local.with_suffix(local.suffix + ".part")
            await sftp.get(path, str(tmp))
            tmp.replace(local)
            return local.stat().st_size

        try:
            return await self._retry(_do)
        except asyncssh.SFTPNoSuchFile as exc:
            raise FileNotFoundError(path) from exc
        except asyncssh.SFTPError as exc:
            raise ExecutorError(f"cannot download {path}: {exc.reason}") from exc

    async def listdir(self, path: str, max_depth: int = 1) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []

        async def walk(sftp, d: str, rel: str, depth: int) -> None:
            for e in await sftp.readdir(d):
                if e.filename in (".", ".."):
                    continue
                a = e.attrs
                is_dir = a.type == asyncssh.FILEXFER_TYPE_DIRECTORY
                rp = f"{rel}/{e.filename}" if rel else e.filename
                out.append({"path": rp, "size": a.size or 0, "mtime": a.mtime or 0, "is_dir": is_dir})
                if is_dir and depth + 1 < max_depth and len(out) < 20000:
                    await walk(sftp, posixpath.join(d, e.filename), rp, depth + 1)

        async def _do() -> list[dict[str, Any]]:
            out.clear()
            sftp = await self._sftp_client()
            await walk(sftp, path, "", 0)
            return sorted(out, key=lambda x: x["path"])

        try:
            return await self._retry(_do)
        except asyncssh.SFTPNoSuchFile as exc:
            raise FileNotFoundError(path) from exc
        except asyncssh.SFTPError as exc:
            raise ExecutorError(f"cannot list {path}: {exc.reason}") from exc

    async def home(self) -> str:
        sftp = await self._sftp_client()
        return await sftp.realpath(".")

    async def upload_file(self, local: Path, path: str) -> None:
        async def _do() -> None:
            sftp = await self._sftp_client()
            d = posixpath.dirname(path)
            if d:
                await sftp.makedirs(d, exist_ok=True)
            await sftp.put(str(local), path)

        await self._retry(_do)

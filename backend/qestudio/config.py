"""Runtime configuration (environment) and on-disk layout."""

from __future__ import annotations

import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Env(BaseSettings):
    """Process-level settings, read from QES_* environment variables."""

    model_config = SettingsConfigDict(env_prefix="QES_", env_file=None, extra="ignore")

    home: Path = Path.home() / ".qestudio"
    host: str = "127.0.0.1"
    port: int = 8765
    # Hard kill-switch for every AI feature. When set, the UI toggle cannot re-enable AI.
    ai_disabled: bool = False
    # Require the per-install API token on every request (protects the localhost API
    # from other web pages / processes). Disable only for debugging.
    auth: bool = True
    # Extra hostnames accepted in the Host header (DNS-rebinding protection).
    allowed_hosts: str = ""
    # Frontend build directory to serve (defaults to ../frontend/dist next to the package).
    static_dir: Path | None = None
    log_level: str = "info"

    @property
    def db_path(self) -> Path:
        return self.home / "qestudio.db"

    @property
    def pseudo_dir(self) -> Path:
        return self.home / "pseudos"

    @property
    def jobs_cache_dir(self) -> Path:
        return self.home / "jobs"

    @property
    def local_runs_dir(self) -> Path:
        return self.home / "runs"

    @property
    def qe_dir(self) -> Path:
        return self.home / "qe"

    @property
    def tmp_dir(self) -> Path:
        return self.home / "tmp"

    @property
    def secrets_path(self) -> Path:
        return self.home / "secrets.json"

    @property
    def token_path(self) -> Path:
        return self.home / "api-token"

    @property
    def known_hosts_path(self) -> Path:
        return self.home / "known_hosts"

    def hosts(self) -> list[str]:
        base = ["localhost", "127.0.0.1", "[::1]", "::1", "testserver"]
        extra = [h.strip() for h in self.allowed_hosts.split(",") if h.strip()]
        return base + extra

    def ensure_dirs(self) -> None:
        for p in (self.home, self.pseudo_dir, self.jobs_cache_dir, self.local_runs_dir, self.qe_dir, self.tmp_dir):
            p.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.home, 0o700)
        except OSError:
            pass

    def api_token(self) -> str:
        """Per-install random token; created on first use with 0600 permissions."""
        p = self.token_path
        if p.exists():
            tok = p.read_text().strip()
            if tok:
                return tok
        tok = secrets.token_urlsafe(32)
        p.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(tok)
        return tok


@lru_cache
def get_env() -> Env:
    env = Env()
    env.ensure_dirs()
    return env

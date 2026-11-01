"""Secret storage: OS keyring when usable, otherwise a 0600 JSON file in QES_HOME.

Secrets never leave the backend: API responses only report whether a secret is set.
"""

from __future__ import annotations

import json
import logging
import os
import threading

from .config import get_env

log = logging.getLogger(__name__)
_SERVICE = "qe-studio"
_lock = threading.Lock()
_keyring_ok: bool | None = None


def _keyring_usable() -> bool:
    global _keyring_ok
    if _keyring_ok is not None:
        return _keyring_ok
    if os.environ.get("QES_NO_KEYRING"):
        _keyring_ok = False
        return False
    try:
        import keyring

        kr = keyring.get_keyring()
        if float(getattr(kr, "priority", 0)) <= 0:
            raise RuntimeError(f"no usable keyring backend ({type(kr).__name__})")
        # smoke test: some backends exist but fail at runtime (headless Linux, no D-Bus)
        keyring.set_password(_SERVICE, "__probe__", "1")
        ok = keyring.get_password(_SERVICE, "__probe__") == "1"
        keyring.delete_password(_SERVICE, "__probe__")
        _keyring_ok = ok
    except Exception as exc:  # pragma: no cover - environment dependent
        log.info("OS keyring unavailable (%s); using file-based secret store", exc)
        _keyring_ok = False
    return bool(_keyring_ok)


def _file_load() -> dict[str, str]:
    p = get_env().secrets_path
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        log.warning("secrets file unreadable; ignoring")
        return {}


def _file_save(data: dict[str, str]) -> None:
    p = get_env().secrets_path
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh)
    os.replace(tmp, p)


def get_secret(name: str) -> str | None:
    with _lock:
        if _keyring_usable():
            try:
                import keyring

                v = keyring.get_password(_SERVICE, name)
                if v is not None:
                    return v
            except Exception:  # pragma: no cover
                pass
        return _file_load().get(name)


def set_secret(name: str, value: str | None) -> None:
    with _lock:
        if _keyring_usable():
            try:
                import keyring

                if value:
                    keyring.set_password(_SERVICE, name, value)
                else:
                    try:
                        keyring.delete_password(_SERVICE, name)
                    except Exception:
                        pass
                # make sure there is no stale copy in the file store
                data = _file_load()
                if name in data:
                    data.pop(name)
                    _file_save(data)
                return
            except Exception:  # pragma: no cover
                pass
        data = _file_load()
        if value:
            data[name] = value
        else:
            data.pop(name, None)
        _file_save(data)


def has_secret(name: str) -> bool:
    return bool(get_secret(name))

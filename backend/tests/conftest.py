"""Shared pytest fixtures.

Every test gets its own QES_HOME (database, pseudopotentials, job cache) in a temporary
directory, so tests are isolated and never touch the user's real data.
"""

from __future__ import annotations

import os
import shutil
import stat
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

DATA = Path(__file__).parent / "data"


def _reset_globals() -> None:
    from qestudio import config, connections, db, pseudos, secrets_store
    from qestudio.executors.local import LocalExecutor

    config.get_env.cache_clear()
    db.reset_engine()
    pseudos._cache.clear()
    connections._pool.clear()
    secrets_store._keyring_ok = None
    LocalExecutor._children.clear()


@pytest.fixture()
def qes_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    home = tmp_path / "qes-home"
    monkeypatch.setenv("QES_HOME", str(home))
    monkeypatch.setenv("QES_NO_KEYRING", "1")
    monkeypatch.delenv("QES_AI_DISABLED", raising=False)
    _reset_globals()
    yield home
    _reset_globals()


@pytest.fixture()
def client(qes_home: Path):
    from fastapi.testclient import TestClient

    from qestudio.main import create_app

    app = create_app()
    with TestClient(app) as c:
        c.headers["X-QES-Token"] = (qes_home / "api-token").read_text().strip()
        yield c


@pytest.fixture()
def data_dir() -> Path:
    return DATA


@pytest.fixture()
def fake_qe(tmp_path: Path) -> Path:
    """A directory with stand-in QE executables.

    ``pw.x`` prints a real pw.x output (tests/data/scf/si.scf.out) after an optional delay
    given by the FAKE_QE_SLEEP environment variable, so the whole job pipeline (runner,
    state files, polling, result download, parsing) can be tested without Quantum ESPRESSO.
    """
    bin_dir = tmp_path / "fake-qe" / "bin"
    bin_dir.mkdir(parents=True)
    out = DATA / "scf" / "si.scf.out"
    script = f"""#!/bin/bash
IN=""
while [ $# -gt 0 ]; do case "$1" in -in|-i|-inp|-input) IN="$2"; shift;; esac; shift; done
[ -f "$IN" ] || {{ echo "input file '$IN' not found" >&2; exit 2; }}
grep -q "FAIL_ME" "$IN" && {{ echo "     Error in routine fake (1): requested failure"; exit 3; }}
sleep "${{FAKE_QE_SLEEP:-0}}"
cat {out}
"""
    for name in ("pw.x", "ph.x", "dos.x", "projwfc.x", "bands.x", "pp.x", "q2r.x", "matdyn.x"):
        p = bin_dir / name
        p.write_text(script)
        p.chmod(p.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return bin_dir


@pytest.fixture()
def wait_for() -> Callable[..., object]:
    def _wait(predicate: Callable[[], object], timeout: float = 30.0, interval: float = 0.25) -> object:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = predicate()
            if last:
                return last
            time.sleep(interval)
        raise AssertionError(f"condition not met within {timeout}s (last={last!r})")

    return _wait


def have(program: str) -> bool:
    return shutil.which(program) is not None or bool(os.environ.get("QES_TEST_QE_BIN"))

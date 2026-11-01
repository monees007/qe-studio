"""Executor transports.

* Jupyter: a real jupyter_server is started on a Kaggle-style base URL
  (/k/<id>/<token>/proxy) when ``jupyter_server`` and ``ipykernel`` are installed.
* SSH: runs only when QES_TEST_SSH="user@host:port" (and optionally QES_TEST_SSH_KEY) is set.
"""

import asyncio
import os
import shutil
import socket
import subprocess
import sys
import time

import pytest

from qestudio.executors.base import ExecutorError
from qestudio.executors.jupyter import JupyterExecutor, parse_jupyter_url
from qestudio.executors.local import LocalExecutor


def test_parse_jupyter_urls():
    base, tok = parse_jupyter_url("https://kkb-production.jupyter-proxy.kaggle.net/k/123/TOKEN/proxy")
    assert base.endswith("/k/123/TOKEN/proxy") and tok == "TOKEN"
    base, tok = parse_jupyter_url("http://localhost:8888/lab/tree/x.ipynb?token=abc")
    assert base == "http://localhost:8888" and tok == "abc"
    base, tok = parse_jupyter_url("https://hub.example.org/user/me/lab?token=t")
    assert base == "https://hub.example.org/user/me" and tok == "t"


async def _roundtrip(ex, root: str) -> None:
    await ex.mkdir(f"{root}/a/b")
    payload = os.urandom(1_300_000)  # > one transfer chunk
    await ex.write_file(f"{root}/a/b/blob.bin", payload)
    assert await ex.read_file(f"{root}/a/b/blob.bin") == payload
    assert await ex.read_file(f"{root}/a/b/blob.bin", 1000, 10) == payload[1000:1010]
    names = {e["path"] for e in await ex.listdir(root, 3)}
    assert "a/b/blob.bin" in names
    r = await ex.run_marked("echo hello; echo err >&2; exit 3")
    assert r.stdout.strip() == "hello" and r.code == 3
    files = await ex.read_small_files(f"{root}/a/b", ["blob.bin", "missing"])
    assert "missing" not in files


def test_local_executor_roundtrip(tmp_path):
    asyncio.run(_roundtrip(LocalExecutor("t", {}), str(tmp_path)))


def test_local_launch_detached_does_not_block(tmp_path):
    async def go():
        ex = LocalExecutor("t", {})
        (tmp_path / "s.sh").write_text("sleep 5\n")
        t0 = time.monotonic()
        pid = await ex.launch_detached(str(tmp_path), ["bash", "s.sh"], "log.txt")
        assert time.monotonic() - t0 < 2
        assert await ex.pid_alive(pid)
        os.killpg(pid, 9)
        await asyncio.sleep(0.3)
        assert not await ex.pid_alive(pid)

    asyncio.run(go())


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def jupyter_url(tmp_path_factory):
    pytest.importorskip("jupyter_server")
    pytest.importorskip("ipykernel")
    port = _free_port()
    root = tmp_path_factory.mktemp("jroot")
    token = "testtoken123"
    base = f"/k/42/{token}/proxy/"
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "jupyter_server",
            "--no-browser",
            "--allow-root",
            f"--port={port}",
            "--ServerApp.ip=127.0.0.1",
            f"--ServerApp.base_url={base}",
            f"--IdentityProvider.token={token}",
            f"--ServerApp.root_dir={root}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://127.0.0.1:{port}{base.rstrip('/')}"
    import httpx

    for _ in range(100):
        try:
            if httpx.get(f"{url}/api/status", params={"token": token}, timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            pass
        time.sleep(0.2)
    else:
        proc.kill()
        pytest.skip("jupyter_server did not start")
    yield url, str(root)
    proc.terminate()
    proc.wait(10)


def test_jupyter_executor_kaggle_style(jupyter_url):
    url, root = jupyter_url

    async def go():
        ex = JupyterExecutor("t", {}, url)
        await ex.connect()
        try:
            await _roundtrip(ex, root)
            (await ex.run("true"))
            pid = await ex.launch_detached(root, ["bash", "-c", "sleep 3"], "launch.log")
            assert await ex.pid_alive(pid)
            # the executor recovers when its kernel is killed
            import httpx

            auth = {"Authorization": f"token {ex.token}"}
            httpx.delete(f"{url}/api/kernels/{ex.kernel_id}", headers=auth)
            await asyncio.sleep(0.5)
            t0 = time.monotonic()
            assert (await ex.run_marked("echo back")).stdout.strip() == "back"
            assert time.monotonic() - t0 < 30, "kernel loss must be detected quickly"
            # a command that was already running when the kernel died is not re-run silently
            kid = ex.kernel_id

            async def kill_soon():
                await asyncio.sleep(1.0)
                await asyncio.to_thread(httpx.delete, f"{url}/api/kernels/{kid}", headers=auth)

            killer = asyncio.create_task(kill_soon())
            with pytest.raises(ExecutorError, match="outcome is unknown"):
                await ex.run("sleep 8")
            await killer
            assert (await ex.run("echo again")).stdout.strip() == "again"
        finally:
            await ex.close(shutdown_kernel=True)

    asyncio.run(go())


@pytest.mark.skipif(not os.environ.get("QES_TEST_SSH"), reason="set QES_TEST_SSH=user@host:port to run")
def test_ssh_executor(tmp_path):
    from qestudio.executors.ssh import SSHExecutor, _parse_hostspec

    host, port, user = _parse_hostspec(os.environ["QES_TEST_SSH"], None)
    cfg = {
        "host": host,
        "port": port,
        "username": user,
        "auth": "key",
        "key_path": os.environ.get("QES_TEST_SSH_KEY", ""),
        "host_key_policy": "ignore",
        "login_shell": True,
    }

    async def go():
        ex = SSHExecutor("t", cfg)
        await ex.connect()
        try:
            root = await ex.expand(f"~/qes-test-{os.getpid()}")
            await _roundtrip(ex, root)
            pid = await ex.launch_detached(root, ["bash", "-c", "sleep 2"], "launch.log")
            assert pid is None  # remote PID comes from the runner's pid file
            await ex.remove_tree(root)
        finally:
            await ex.close()

    asyncio.run(go())


@pytest.mark.skipif(shutil.which("pw.x") is None, reason="Quantum ESPRESSO (pw.x) not on PATH")
def test_real_pw_scf(tmp_path, data_dir):
    """Smoke test with real QE when available (uses the bundled test input and needs its pseudo)."""
    pseudo = os.environ.get("QES_TEST_PSEUDO_DIR")
    if not pseudo:
        pytest.skip("set QES_TEST_PSEUDO_DIR to a folder containing Si.pbe-tm-test.UPF")
    text = (data_dir / "scf" / "si.scf.in").read_text().replace("../pseudo", pseudo)
    (tmp_path / "scf.in").write_text(text)
    out = subprocess.run(
        ["pw.x", "-in", "scf.in"], cwd=tmp_path, capture_output=True, text=True, timeout=300, check=False
    )
    assert "JOB DONE" in out.stdout

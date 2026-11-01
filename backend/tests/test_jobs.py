"""Job pipeline through the HTTP API on the local connection, using stand-in QE executables."""

import os
import signal

import pytest

SCF = """&CONTROL
  calculation = 'scf'
  prefix = 'si'
  outdir = '/somewhere/else'
/
&SYSTEM
  ibrav = 2, celldm(1) = 10.26, nat = 2, ntyp = 1, ecutwfc = 30.0
/
&ELECTRONS
/
ATOMIC_SPECIES
  Si 28.086 Si.test.UPF
ATOMIC_POSITIONS crystal
  Si 0.00 0.00 0.00
  Si 0.25 0.25 0.25
K_POINTS automatic
  4 4 4 0 0 0
"""


@pytest.fixture()
def local_conn(client, fake_qe, data_dir):
    files = [("files", ("Si.test.UPF", (data_dir / "Si.header-only.UPF").read_bytes(), "text/plain"))]
    assert client.post("/api/pseudos/upload", files=files).json()["added"] == ["Si.test.UPF"]
    conn = client.get("/api/connections").json()[0]
    cfg = {**conn["config"], "qe_bin_dir": str(fake_qe), "mpi_command": ""}
    r = client.put(f"/api/connections/{conn['id']}", json={"name": conn["name"], "kind": "local", "config": cfg})
    assert r.status_code == 200, r.text
    return conn["id"]


def submit(client, conn_id, text=SCF, name="scf"):
    r = client.post(
        "/api/jobs",
        json={
            "name": name,
            "connection_id": conn_id,
            "kind": "scf",
            "workflow": {"kind": "scf"},
            "steps": [{"label": "scf", "program": "pw.x", "input_name": "scf.in", "input": text, "save_xml": None}],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def status(client, job_id):
    return client.get(f"/api/jobs/{job_id}").json()


def test_connection_probe_finds_fake_qe(client, local_conn):
    r = client.post(f"/api/connections/{local_conn}/test").json()
    assert r["ok"], r
    assert r["info"]["programs"]["pw.x"].endswith("pw.x")


def test_job_runs_and_results_are_parsed(client, local_conn, wait_for):
    job_id = submit(client, local_conn)
    job = wait_for(lambda: (j := status(client, job_id))["status"] in ("done", "failed") and j, timeout=60)
    assert job["status"] == "done", job["error"]
    # paths were rewritten so the job directory is self-contained
    sent = client.get(f"/api/jobs/{job_id}/file", params={"path": "scf.in", "source": "remote"}).text
    assert "outdir" in sent and "./tmp/" in sent and "./pseudo/" in sent
    results = wait_for(lambda: (r := client.get(f"/api/jobs/{job_id}/results").json()).get("pw") and r, timeout=30)
    assert results["pw"]["summary"]["final_energy_ry"] == pytest.approx(-20.41157462)
    tail = client.get(f"/api/jobs/{job_id}/file", params={"path": "scf.out"}).text
    assert "JOB DONE" in tail


def test_failed_step_marks_job_failed(client, local_conn, wait_for):
    job_id = submit(client, local_conn, SCF.replace("prefix = 'si'", "prefix = 'FAIL_ME'"))
    job = wait_for(lambda: (j := status(client, job_id))["status"] in ("done", "failed") and j, timeout=60)
    assert job["status"] == "failed" and "exited with code 3" in job["error"]


def test_cancel_stops_the_process_group(client, local_conn, wait_for, monkeypatch):
    monkeypatch.setenv("FAKE_QE_SLEEP", "120")
    job_id = submit(client, local_conn, name="long")
    wait_for(lambda: status(client, job_id)["status"] == "running", timeout=30)
    pid = int(status(client, job_id)["remote_job_id"])
    assert client.post(f"/api/jobs/{job_id}/cancel").json()["status"] == "cancelled"

    def gone():
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        return (
            open(f"/proc/{pid}/stat").read().split(")")[-1].split()[0] == "Z"
            if os.path.exists(f"/proc/{pid}")
            else True
        )

    wait_for(gone, timeout=15)


def test_killed_runner_is_detected_as_lost(client, local_conn, wait_for, monkeypatch):
    monkeypatch.setenv("FAKE_QE_SLEEP", "120")
    job_id = submit(client, local_conn, name="victim")
    wait_for(lambda: status(client, job_id)["status"] == "running", timeout=30)
    pid = int(status(client, job_id)["remote_job_id"])
    os.killpg(pid, signal.SIGKILL)
    job = wait_for(
        lambda: (client.post(f"/api/jobs/{job_id}/refresh").json()["status"] == "lost") and status(client, job_id),
        timeout=30,
    )
    assert "disappeared" in job["error"]


def test_missing_pseudopotential_is_rejected(client, local_conn):
    r = client.post(
        "/api/jobs",
        json={
            "name": "x",
            "connection_id": local_conn,
            "steps": [
                {
                    "label": "scf",
                    "program": "pw.x",
                    "input_name": "scf.in",
                    "input": SCF.replace("Si.test.UPF", "Nope.UPF"),
                }
            ],
        },
    )
    assert r.status_code == 400 and "Nope.UPF" in r.json()["detail"]


def test_unsafe_file_names_are_rejected(client, local_conn):
    r = client.post(
        "/api/jobs",
        json={
            "name": "x",
            "connection_id": local_conn,
            "steps": [{"label": "scf", "program": "pw.x", "input_name": "../evil.in", "input": SCF}],
        },
    )
    assert r.status_code == 400

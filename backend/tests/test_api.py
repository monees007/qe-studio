"""HTTP API: security guards, settings, AI kill switch and the main CRUD endpoints."""

import pytest


def test_token_required(client):
    tok = client.headers.pop("X-QES-Token")
    assert client.get("/api/health").status_code == 200  # health is public
    assert client.get("/api/meta").status_code == 401
    assert client.get("/api/meta", params={"token": "wrong"}).status_code == 401
    assert client.get("/api/meta", params={"token": tok}).status_code == 200


def test_foreign_host_header_rejected(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400


def test_settings_roundtrip_and_secret_never_returned(client):
    s = client.put("/api/settings", json={"energy_unit": "Ry", "poll_interval_s": 5}).json()
    assert s["energy_unit"] == "Ry" and s["poll_interval_s"] == 5
    s = client.put("/api/settings/secrets", json={"anthropic_api_key": "sk-ant-test"}).json()
    assert s["has_anthropic_key"] is True
    assert "sk-ant-test" not in client.get("/api/settings").text


def test_ai_master_switch_blocks_every_ai_endpoint(client):
    client.put("/api/settings", json={"ai_enabled": False})
    assert client.get("/api/settings").json()["ai_available"] is False
    r = client.post("/api/ai/ask", json={"question": "hi"})
    assert r.status_code == 403
    assert client.get("/api/ai/models").status_code == 403
    assert client.get("/api/meta").json()["ai"]["available"] is False


def test_ai_hard_disable_overrides_setting(qes_home, monkeypatch):
    monkeypatch.setenv("QES_AI_DISABLED", "1")
    from qestudio import config

    config.get_env.cache_clear()
    from fastapi.testclient import TestClient

    from qestudio.main import create_app

    with TestClient(create_app()) as c:
        c.headers["X-QES-Token"] = (qes_home / "api-token").read_text().strip()
        c.put("/api/settings", json={"ai_enabled": True})
        s = c.get("/api/settings").json()
        assert s["ai_hard_disabled"] and not s["ai_available"]
        assert c.post("/api/ai/ask", json={"question": "hi"}).status_code == 403


def test_ai_without_key_gives_clear_error(client):
    r = client.post("/api/ai/ask", json={"question": "hi"})
    assert r.status_code == 400 and "API key" in r.json()["detail"]


def test_structure_crud(client):
    st = client.post(
        "/api/structures/build",
        json={"kind": "bulk", "params": {"formula": "MgO", "crystalstructure": "rocksalt", "a": 4.21}},
    ).json()["structure"]
    rec = client.post("/api/structures", json={"name": "MgO", "structure": st}).json()
    assert rec["formula"] == "MgO" and rec["natoms"] == 2
    assert client.get("/api/structures").json()[0]["spacegroup"] == "Fm-3m"
    assert client.delete(f"/api/structures/{rec['id']}").status_code == 200
    assert client.get(f"/api/structures/{rec['id']}").status_code == 404


def test_structure_parse_upload(client, data_dir):
    r = client.post(
        "/api/structures/parse", files={"file": ("si.scf.in", (data_dir / "scf" / "si.scf.in").read_bytes())}
    )
    assert r.status_code == 200 and r.json()["structures"][0]["sites"]


def test_qe_endpoints(client, data_dir):
    text = (data_dir / "scf" / "si.scf.in").read_text()
    parsed = client.post("/api/qe/parse", json={"text": text}).json()
    assert parsed["program"] == "pw" and len(parsed["structure"]["sites"]) == 2
    rendered = client.post("/api/qe/render", json={"doc": parsed["doc"]}).json()["text"]
    assert "ATOMIC_POSITIONS {crystal}" in rendered
    v = client.post("/api/qe/validate", json={"text": text}).json()
    assert any("not in your library" in i["message"] for i in v["issues"])
    assert client.get("/api/qe/schema/pw").json()["namelists"]["SYSTEM"]
    assert "&DOS" in client.post("/api/qe/template", json={"program": "dos", "prefix": "si"}).json()["text"]
    bad = client.post("/api/qe/parse", json={"text": "&control\n"})
    assert bad.status_code == 400


def test_documents_crud(client):
    d = client.post("/api/documents", json={"name": "a.in", "content": "&control\n/\n"}).json()
    assert client.put(f"/api/documents/{d['id']}", json={"name": "b.in", "content": "x"}).json()["name"] == "b.in"
    assert [x["name"] for x in client.get("/api/documents").json()] == ["b.in"]
    client.delete(f"/api/documents/{d['id']}")
    assert client.get("/api/documents").json() == []


def test_pseudo_upload_and_defaults(client, data_dir):
    files = [
        ("files", ("Si.a.UPF", (data_dir / "Si.header-only.UPF").read_bytes())),
        ("files", ("Si.b.UPF", (data_dir / "Si.header-only.UPF").read_bytes())),
        ("files", ("bad.UPF", b"not a pseudo")),
    ]
    r = client.post("/api/pseudos/upload", files=files).json()
    assert sorted(r["added"]) == ["Si.a.UPF", "Si.b.UPF"] and r["errors"]
    lib = client.get("/api/pseudos").json()
    assert lib["defaults"]["Si"] == "Si.a.UPF"
    client.put("/api/pseudos/defaults", json={"element": "Si", "filename": "Si.b.UPF"})
    assert client.get("/api/pseudos").json()["defaults"]["Si"] == "Si.b.UPF"
    assert client.delete("/api/pseudos/Si.b.UPF").status_code == 200
    assert "Si" not in client.get("/api/pseudos").json()["defaults"]


@pytest.mark.parametrize("name", ["../x.UPF", ".hidden.UPF"])
def test_pseudo_bad_names(client, data_dir, name):
    r = client.post(
        "/api/pseudos/upload", files=[("files", (name, (data_dir / "Si.header-only.UPF").read_bytes()))]
    ).json()
    assert r["added"] in ([], ["x.UPF"])  # path components are stripped; hidden names refused


def test_connection_validation(client):
    r = client.post("/api/connections", json={"name": "x", "kind": "ssh", "config": {}})
    assert r.status_code == 400
    r = client.post("/api/connections", json={"name": "k", "kind": "jupyter", "jupyter_url": "ftp://nope"})
    assert r.status_code == 400
    r = client.post(
        "/api/connections",
        json={
            "name": "k",
            "kind": "jupyter",
            "jupyter_url": "https://kkb-production.jupyter-proxy.kaggle.net/k/1/abc/proxy",
        },
    )
    assert r.status_code == 200 and r.json()["has_jupyter_url"]
    assert "abc" not in r.text  # the token-bearing URL is never echoed back


def test_websocket_token_via_subprotocol(client):
    tok = client.headers.pop("X-QES-Token")
    with client.websocket_connect("/api/ws/events", subprotocols=["qes", f"token.{tok}"]) as ws:
        assert ws.accepted_subprotocol == "qes"
    import pytest
    from starlette.websockets import WebSocketDisconnect

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/api/ws/events", subprotocols=["qes", "token.bad"]),
    ):
        pass

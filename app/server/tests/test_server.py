"""RefuelAnim's server: Home over the vault of animation files, and the vault's other files (CAD)."""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def c(tmp_path, monkeypatch):
    monkeypatch.setenv("REFUELANIM_PROJECTS", str(tmp_path / "vault"))
    from refuelanim_server import app as mod
    mod._stores.clear()
    mod._vault.clear()
    return TestClient(mod.app)


def test_an_animation_saved_in_the_vault(c, tmp_path):
    pid = c.post("/api/projects", json={"name": "Lid", "problem": {"name": "Lid", "script": {"language": "anim", "text": "wait 2s"}}}).json()["id"]
    m = c.get(f"/api/projects/{pid}").json()["problem"]
    assert m["solver"] == "refuel-anim" and m["script"]["text"] == "wait 2s"
    assert (tmp_path / "vault" / "Lid.json").exists()


def test_cad_files_are_served_from_the_vault(c, tmp_path):
    (tmp_path / "vault" / "CAD").mkdir(parents=True)
    (tmp_path / "vault" / "CAD" / "m.glb").write_bytes(b"glTF\x02\x00\x00\x00")
    assert c.get("/api/files/CAD/m.glb").content.startswith(b"glTF")


def test_assist_proxy_requests_are_logged(c, tmp_path, monkeypatch):
    # no key: the proxy answers at once (503); the log still gets its line, with the page's send id
    for k in ("REFUELANIM_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "VITE_ANTHROPIC_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    (tmp_path / "vault").mkdir(parents=True, exist_ok=True)
    r = c.post("/api/assist/proxy/v1/messages", json={"model": "x", "messages": []}, headers={"x-assist-send": "2026-11-27_10-00-00-abcd#1"})
    log = tmp_path / "vault" / "Logs" / "assist" / "proxy.jsonl"
    assert log.exists()
    import json
    rec = json.loads(log.read_text().splitlines()[-1])
    assert rec["send"] == "2026-11-27_10-00-00-abcd#1" and rec["status"] == r.status_code and rec["outcome"] == "done"
    assert rec["path"] == "/api/assist/proxy/v1/messages" and isinstance(rec["ms"], int)
    assert "x-api-key" not in log.read_text() and "messages" not in rec
    # other routes aren't logged
    c.get("/api/files?folder=CAD")
    assert len(log.read_text().splitlines()) == 1

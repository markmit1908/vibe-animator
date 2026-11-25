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

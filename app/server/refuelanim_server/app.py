"""RefuelAnim's server: SolverKit's platform (create_app with the standard features) over a vault of animation files.
No engine: animations play in the browser. The vault's other files (the shared CAD .glb models) are served by
PlatformApp(files=True) at /api/files/{path}.

    uvicorn refuelanim_server.app:app --port 8100      (REFUELANIM_PROJECTS: the vault; default ~/Documents/Refuel animations)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from solverkit.api import ApiV1, HomeApp, PlatformApp, create_app
from solverkit.paths import AppPaths
from solverkit.store import ModelStore



def _load_dotenv(path: Path) -> None:
    """KEY=value lines from the repo's .env (git-ignored) into the server's environment; set variables win.
    Server-side only: the key never reaches the page (the assist proxy adds it)."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))
    except OSError:
        pass


_load_dotenv(Path(__file__).resolve().parents[3] / ".env")

PATHS = AppPaths("RefuelAnim", "REFUELANIM", Path(__file__).resolve().parents[2])
# The vault defaults to ~/Documents/Refuel animations (in dev too: it holds the real animations and CAD).
PATHS.default_vault = lambda: Path.home() / "Documents" / "Refuel animations"  # type: ignore[method-assign]
_SCHEMA_DIR = Path(getattr(sys, "_MEIPASS", "")) if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[2] / "src"
SCHEMA = json.loads((_SCHEMA_DIR / "model.schema.json").read_text(encoding="utf-8"))


class Store(ModelStore):
    SOLVER = "refuel-anim"
    FORMAT = 1
    # the model's fields, in file order (src/model/file.ts in the repo root)
    MODEL_FIELDS = ("name", "uuid", "solver", "format", "scene", "script", "snapshots", "groups", "colors", "removed", "labels", "view", "chat", "thumbnail")
    FILE_FIELDS = ("description",)
    LINES = ("description",)
    # view state and the chat don't change what the animation is
    HASH_EXCLUDED = ("view", "chat", "thumbnail")


_stores: dict[Path, Store] = {}
_vault: list[Path] = []


def vault() -> Path:
    return _vault[0] if _vault else PATHS.vault()


def store() -> Store:
    root = vault()
    if root not in _stores:
        _stores[root] = Store(root)
        _stores[root].assign_uuids()
    return _stores[root]


def set_vault(p: Path) -> None:
    _vault[:] = [p]


def to_file(m: dict) -> dict:
    """A model as saved: the defaults, then what was given."""
    base = {"solver": "refuel-anim", "format": 1, "scene": {"generated": False, "cad_models": []},
            "script": {"language": "anim", "text": ""}, "snapshots": {"active": "default", "items": {"default": {"locked": {}, "hidden": {}}}},
            "groups": {}}
    return {**base, **m}


app = create_app(PlatformApp(
    name="RefuelAnim", env_prefix="REFUELANIM", version=lambda: "0.1.0", settings_file=PATHS.settings_file,
    vault=vault, set_vault=set_vault, files=True,
    home=HomeApp(store=store, to_file=to_file, zip_name="Refuel animations", manifest=lambda: {"refuel-anim": "0.1.0"}),
    api_v1=ApiV1(name="RefuelAnim", version=lambda: "0.1.0", store=store, schema=SCHEMA, settings_file=PATHS.settings_file),
    assist_key=lambda: os.environ.get("REFUELANIM_ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("VITE_ANTHROPIC_API_KEY"),
))

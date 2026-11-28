"""RefuelAnim's server: SolverKit's platform (create_app with the standard features) over a vault of animation files.
No engine: animations play in the browser. The vault's other files (the shared CAD .glb models) are served by
PlatformApp(files=True) at /api/files/{path}.

    uvicorn refuelanim_server.app:app --port 8100      (REFUELANIM_PROJECTS: the vault; default ~/Documents/Refuel animations)
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
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
    MODEL_FIELDS = ("name", "uuid", "solver", "format", "scene", "script", "drawings", "snapshots", "groups", "folders", "colors", "removed", "cutKeep", "labels", "views", "keyframe", "shapes", "copies", "annotations", "view", "chat", "thumbnail")
    FILE_FIELDS = ("description",)
    LINES = ("description",)
    # view state and the chat don't change what the animation is
    HASH_EXCLUDED = ("view", "chat", "thumbnail", "keyframe", "folders")


_stores: dict[Path, Store] = {}
_vault: list[Path] = []


def vault() -> Path:
    # resolved: SolverKit's file listing compares walked paths with the root, which fails through a symlink
    # (macOS /var -> /private/var). solverkit-candidate: resolve the root in Vault.
    return (_vault[0] if _vault else PATHS.vault()).resolve()


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


class AssistProxyLog:
    """Logs each request through the assist key proxy (/api/assist/proxy…) to <vault>/Logs/assist/proxy.jsonl: when it
    started, the send it belongs to (x-assist-send, from the page's own log), the upstream status, time to first
    byte, bytes streamed, duration and how it ended (done / client disconnected / error). Streams pass through
    untouched; nothing of the request body or the key is written. Pure ASGI, so streaming isn't buffered."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or not scope.get("path", "").startswith("/api/assist/proxy"):
            return await self.app(scope, receive, send)
        t0 = time.monotonic()
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        rec: dict = {"t": datetime.now(timezone.utc).isoformat(), "send": headers.get("x-assist-send"), "method": scope.get("method"),
                     "path": scope.get("path"), "status": None, "first_byte_ms": None, "bytes": 0, "chunks": 0, "outcome": None}

        complete = [False]   # the last body chunk went out

        async def receive_logged():
            msg = await receive()
            # a disconnect after the whole response went out is the normal end of a stream, not a drop
            if msg.get("type") == "http.disconnect" and rec["outcome"] is None and not complete[0]:
                rec["outcome"] = "client disconnected"
            return msg

        async def send_logged(msg):
            if msg["type"] == "http.response.start":
                rec["status"] = msg.get("status")
            elif msg["type"] == "http.response.body":
                body = msg.get("body", b"")
                if body and rec["first_byte_ms"] is None:
                    rec["first_byte_ms"] = round((time.monotonic() - t0) * 1000)
                rec["bytes"] += len(body)
                rec["chunks"] += 1
                if not msg.get("more_body", False):
                    complete[0] = True
            await send(msg)

        try:
            await self.app(scope, receive_logged, send_logged)
            rec["outcome"] = rec["outcome"] or "done"
        except BaseException as e:   # includes cancellation when the page goes away
            rec["outcome"] = f"error: {type(e).__name__}: {e}"[:300]
            raise
        finally:
            rec["ms"] = round((time.monotonic() - t0) * 1000)
            try:
                d = vault() / "Logs" / "assist"
                d.mkdir(parents=True, exist_ok=True)
                with (d / "proxy.jsonl").open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + "\n")
            except OSError:
                pass


app.add_middleware(AssistProxyLog)

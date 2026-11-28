# RefuelAnim

Refuel Animation: animations of reactor refuelling over CAD models, on SolverKit. Each animation is one model file
(`solver: refuel-anim`, format 1; `../src/model/file.ts`) in a vault (default `~/Documents/Refuel animations`); the CAD
`.glb` files live in the vault's `CAD/` folder and are shared between animations (served at `/api/files/CAD/...`).
The 3D core (scene build, timeline compiler, player, CAD, drawing mode, assist tools) lives in the repo's `../src/`
and is imported by this app; the old Vite-only app at the repo root is retired in step M6 of the migration.

## SolverKit (shared platform)
This app is built on SolverKit (see `solverkit/CLAUDE.md` and `specs/` in the SolverKit repo).
- Use SolverKit packages for the UI components, charts, model editor, app frame, engine adapter, plugin host, store, pinning, APIs, reports, AI assist, the external API (REST `/api/v1` and MCP), units, data tables, studies, runs, the desktop platform module (macOS checked; Windows builds but is not yet checked by hand) and `solverkit-core` utilities (C API conventions, UUIDs, hashing, canonical JSON, vault, units, tables, the plugin compute ABI). `docs/ADOPTING.md` lists what each package version offers.
- Do not reimplement anything SolverKit provides. If something needed is missing or needs a change, propose it as a SolverKit change (with a changeset). Until it is published, implement it in this app behind the same interface and mark it `// solverkit-candidate`.
- This app contributes only:
  - its engine (on `solverkit-core`)
  - its model-schema extensions
  - its app modules (views, commands, settings, exporters), registered through SolverKit registries
  - its examples, help topics and standard-pack plugins
- Pin exact SolverKit versions. Upgrades are separate, reviewed changes.

## SolverKit modules installed
- `model-file`: Export / Replace from a model file (.json)
- `help`: the Help tab (src/help.md)
- AI assist: SolverKit's `AssistPanel`, mounted in the Studio's Assist tab by `src/assist.tsx` (our proposal kinds:
  script edit, groups, state, shapes, copies, annotations, placement), over the studio's loop and tools (`../src/assist`, `AssistHost`) and SolverKit's assist key proxy
  (`PlatformApp(assist_key=…)`, `/api/assist/proxy`). The key: REFUELANIM_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY /
  VITE_ANTHROPIC_API_KEY from the environment or the repo's `.env` (read server-side by `app.py`).

Add or remove one with `/solverkit-modules`; the app's side of each is in `docs/SOLVERKIT.md` (A1–A11).

## Layout
- No engine and no runs: animations play in the browser (ModelEditor without `run`)
- `src/model.schema.json`: the model schema, annotated (SolverKit `specs/schema-annotations.md`)
- `src/main.tsx`: manifest and boot; `src/run.ts`: model type, store and engine adapter; `src/module.tsx`: the modules
- `server/`: the Python server (`create_app(PlatformApp(…, files=True))`), vault-backed `ModelStore`
- `src/assist.tsx`: SolverKit's AssistPanel and our proposal kinds; `src/studio.tsx`: mounts the studio, sends card images (`store.putThumb`)
- Setup: SolverKit is a sibling checkout (`../../vibe-solverkit`); `solverkit.dev.json` installs its Python package by relative path

## Commands
- `npm run dev`: server and frontend (`solverkit.dev.json`)
- `npm run build`
- `PYTHONPATH=server .venv/bin/pytest -q server/tests`; `npm run test:e2e`

---
description: Start a new *Solver on SolverKit with the standard modules; you write only the engine, schema and manifest
argument-hint: "<Name> <c-prefix> [target dir]"
---

# A new *Solver on SolverKit (clean install)

Arguments: `$ARGUMENTS`: the name (e.g. `RaySolver`), the C API prefix (e.g. `rs`), and optionally the target directory (default `../vibe-<name lowercased>`).

**SolverKit** is `../vibe-solverkit` (ask if it isn't there). Read its CLAUDE.md, `prompts/modules/README.md`, `docs/ADOPTING.md` and `templates/create-solver.sh` (its options are in its header; the skeleton is `templates/solver/`). If the target directory exists and isn't empty, stop and ask.

## 1. Gather (no changes)
Read whatever concept or spec the user has for the solver (e.g. its README or concept doc). Then ask, with AskUserQuestion:
1. **Modules** (multi-select, with a one-line note each) of what the script installs: `model-file`, `help`, `examples`, `parameters`, `results`, `runs`, `diagnostics`, `units`, `report`, `apps`, `studies`, `tables` (with data files), `drawings`, `assist`. Recommend all but `assist`, which is the script's default; `assist` when the concept asks for AI help.
2. **Targets**: the engine in the browser (WASM) and on the server (the default), or on the server only (`--no-wasm`). On the server only, Run can be a durable run (`--durable-runs`): a worker process (`server/<name>_server/worker.py`, `ProcessRuns`) that outlives the server, listed in the Runs view; recommend it when runs are long. Or in the browser only (`--no-server`): no Python server and no desktop, the models kept in the browser's storage (`browserStore`, with .zip export and import), the engine as WASM, studies run here; no PDF reports and no `assist` (refused with it, and with `--no-wasm`). Recommend it for a demo or a static site.
3. **Desktop**: the desktop shell config (default) or none (`--no-desktop`; implied by `--no-server`).
List `tutorials` (it needs the app's own tutorial service) and the ⏳ catalog modules as "later, with /solverkit-modules or by upgrading", not as choices. Unless `--no-server`, a server is generated: the store is its vault.

## 2. Show what the solver writes
Before generating, show the user the **development list**: README "The app's side", A1–A11, plus table B for each chosen module, each with its interface and the generated file it starts from. Confirm it with the chosen modules.

## 3. Generate
From SolverKit:

    templates/create-solver.sh --modules <a,b,c> [--no-wasm [--durable-runs] | --no-server] [--no-desktop] [--ports WEB,API] <Name> <prefix> <target dir>

With `EMSDK` set it builds the WASM engine too. It writes only the app's own code: the engine stub (C API, chunked, cancellable) and its WASM script, `src/model.schema.json` (one input, one output), `src/main.tsx` (manifest and boot), `src/run.ts` (model type, store, `EditorRun`), `src/module.tsx` (the chosen modules, no views), the server (`create_app(PlatformApp(…))` with the matching features), `solverkit.dev.json` and the Vite `/api` proxy, the desktop config, an e2e test, these prompts in `.claude/commands/`, a CLAUDE.md (SolverKit section and the module list) and `docs/SOLVERKIT.md` (A1–A11 with `TODO(…)` markers). Outside SolverKit's workspace the packages are linked from the checkout (`link:`); pin published versions later (`scripts/vendor.sh`, `scripts/vendor-py.sh`).

Don't edit the generated code beyond what the user asked for: the stubs compile and pass their tests.

## 4. Prove and report
In the target: `npx -y pnpm@9.15.9 install`, `cmake -S engine -B engine/build && cmake --build engine/build && ctest --test-dir engine/build`, create `.venv` (`uv venv -p 3.12 .venv && uv pip install -p .venv -e '<solverkit>/python[api,test]'`), `PYTHONPATH=server .venv/bin/pytest -q server/tests`, `npm run build`, `npm run test:e2e`; then `npm run dev` once and check the page loads and `/api/about` answers through Vite. With `--no-server` there is no `.venv`, server test or `/api`: the WASM build (`EMSDK=… engine/build-wasm.sh`), `npm run build` and `npm run test:e2e`, and the page loads under `npm run dev`. `git init` and make the first commit. Report: the directory, the modules and options, the TODO list (`grep -rn "TODO(" .`), test counts.

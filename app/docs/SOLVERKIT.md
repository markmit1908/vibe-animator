# RefuelAnim on SolverKit: the app's side

What RefuelAnim writes; SolverKit supplies the rest (its `prompts/modules/README.md`, "The app's side"). `TODO` marks what the
generated stub leaves to do; `grep -rn "TODO(" .` finds them in the code.

| # | The app writes | Where | State |
|---|---|---|---|
| A1 | Engine: the method in Python (`Run`: `advance` chunked, `array`, `free`; `version`), in a worker process (D7: no WASM, no offline version) | `server/refuelanim_server/engine.py` | TODO(engine): a stub integrating a·x |
| A2 | Model schema, annotated (`x-solverkit`, `x-solverkit-outputs`; or `configureApp({ inputs(model), outputs(model) })` when they depend on the model) | `src/model.schema.json` | TODO(schema): one input `a`, one output `y` |
| A3 | Manifest: name, tagline, icon, noun, `updateRepo` | `src/main.tsx` | TODO(manifest): tagline, icon |
| A4 | Boot: `configureApp` and `<SolverApp editor={<ModelEditor>}>` | `src/main.tsx` | done |
| A5 | Store: the server's vault through `/api` (`serverStore`) | `src/run.ts`, `server/` | done; TODO(model): the model's fields (`Model`, `MODEL_FIELDS`, `to_file`) |
| A6 | Engine adapter: the server's `/api/run` job (the Python engine in a worker process), polled (`polled`) | `src/run.ts` | done for the stub |
| A7 | Editor: `ModelEditor` with the app's `EditorRun` (`RUN`) | `src/run.ts`, `src/main.tsx` | done |
| A8 | Contexts: none (one `EditorContext`) | — | done |
| A9 | Server: `create_app(PlatformApp(…))`, `ModelStore`, `HomeApp`, `/api/run` | `server/refuelanim_server/app.py` | done; TODO(tests) |
| A10 | Solver views: only what no module expresses | `src/module.tsx` | none yet: TODO(views) |
| A11 | `npm run dev`: `solverkit.dev.json`, the Vite `/api` proxy | `solverkit.dev.json`, `vite.config.ts` | done |

## Modules
- `model-file`: nothing to write
- `help`: TODO(help): src/help.md
- `examples`: TODO(examples): the solver's examples in src/examples/
- `assist`: TODO(assist): the system text in src/module.tsx; set REFUELANIM_ANTHROPIC_API_KEY

## Also
- TODO(examples): the solver's examples in `src/examples/` (each opens as a copy).
- TODO(help): `src/help.md`, one topic per heading.
- TODO(e2e): `e2e/app.spec.ts`.

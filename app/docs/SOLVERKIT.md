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

## SolverKit candidates found during the migration (propose in the SolverKit repo)
1. **Home: app importers can't claim a `.zip`.** `Home.tsx` `importFile` sends every `.zip` to the built-in archive
   import before `opts.importers`. Proposal: try `importers.find(match)` first (or an importer flag `claimsZip`).
   Until then: `src/oldImportSection.tsx` (a Home section, `// solverkit-candidate`).
2. **Home: "New model" ignores `manifest.noun`** (shows "New model" in an app whose noun is "animation").
3. **create-solver template:** with modules that exclude `runs`, the generated `src/module.tsx` still calls
   `runsModule(...)` without importing it.
4. **Views without runs:** works (`ModelEditor` `run` optional); nothing to change, noted for apps without an engine.
5. **AssistPanel: no styles for reply Markdown.** `.assist-reply` has no list/code styles of its own; ours are in
   `src/index.css` (`// solverkit-candidate`). Proposal: ship them with the panel.
6. **AssistPanel: no header or code-block action slots.** We wrap it for the effort selector and status line, and post-process
   `replyHtml` for "Insert into script". Proposal: `header` and `codeActions` props.
7. **Card thumbnails from a non-React view.** The Studio renders its own card image and calls `store.putThumb` directly
   (`src/studio.tsx`), outside the frame's ThumbnailApi. Proposal: expose the ThumbnailApi's `capture` to views via the
   module context.

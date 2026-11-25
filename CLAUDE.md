# CLAUDE.md

Interactive Three.js animation of refuelling a hex-block (HTGR-style) reactor core,
used to illustrate the concept. Delivered live in a browser.

## Commands
- `npm run dev`: Vite dev server
- `npm run typecheck`: `tsc --noEmit`. Run it after every TS change.
- `npm run build`: typecheck plus a production bundle

## Architecture
- `scenes/core.yaml` → `src/scene/build.ts` → `BuiltScene` (registry of animatable objects by id, slots, columns, locations, clip planes)
- `scripts/refuel.yaml` → `src/timeline/compile.ts` → a flat list of `Tween`s and `StepEvent`s (label, cutaway)
- `src/timeline/player.ts`: `seek(t)` resets every registered object to its initial state and re-applies every tween up to t. It runs **every frame**, so playback is stateless and scrubbable. Never mutate animated state outside tweens.
- The compiler simulates a "virtual state" so each tween knows its from-value. `pick`/`place` expand into machine moves; the machine carries whatever it `held`s.
- Cutaway: shells are clipped with the shared `clipPlanes` (each material needs `clippingPlanes` and `clipIntersection: true`). Core blocks inside the cut region are hidden whole. This is reapplied after `seek` each frame.

- CAD (`cad_models` in core.yaml) is loaded **before** compiling (top-level await), so scripts can target CAD node ids (`<model>/<child>/…`).
- Player resets only `tl.touched` ids each frame. Visibility = not faded (script) AND not cut (cutaway) AND not `userData.userHidden` (tree toggle). Keep all three when touching `.visible`.

- Part state (`src/scene/state.ts`, `scenes/state.yaml` via the `/__state` endpoint in vite.config.ts): explicit `locked`/`hidden` flags by id, inherited by descendants. `reconcile()` in main.ts applies them. Locked → `matrixAutoUpdate=false` (and `matrixWorldAutoUpdate=false` for fully locked subtrees). Locked + hidden CAD → `CadManager.suppress` frees geometry; `restore` reloads it from the .glb by id.
- Changing locks recompiles the script. Scripts may not target locked objects.

- `generated: false` in core.yaml builds the parametric reactor and then drops it (lights and grid stay). The registry then holds CAD only. `script:` selects scripts/<name>.yaml; with no `camera:` the view frames everything loaded.

## Conventions
- Y is up, units are metres, and the core base is at y = 0. The operating floor sits at the vessel flange (`floorY`), and locations are relative to it.
- The machine's origin is the grapple tip.
- Block ids are `R<ring>-<i>/L<n>`, with L0 at the bottom. Hex layout is axial, flat-top.
- Script expressions `{...}` are evaluated with `with(Math)`, so don't name script variables after Math functions (`floor`, `max`, …). The floor height variable is `floorY` for this reason.
- Look and feel: cel-shaded (MeshToonMaterial with a 3-band ramp), black background, black outlines, off-white plus a copper accent. Use the `toon()` helper in build.ts, not Lambert/Standard materials. Colours come from `palette` in core.yaml.
- All dimensions are currently placeholders until the user supplies real numbers.

## CAD
- `data/` holds raw CAD and is git-ignored. Never commit it; the plant STEP is 757 MB.
- `tools/step2gltf.py` (uv inline deps, cadquery-ocp, Python <3.13) has three commands: `tree`, `audit`, `convert`. Parsing the plant model takes about 3 minutes and 6 GB, so run it in the background.
- OCCT's glTF writer does not share meshes between instances, so `convert` re-instances baked copies (principal axes + vertex check), merges faces (one primitive per part), then runs `gltf-transform dedup`. Never use gltf-transform `instance`: it flattens the hierarchy and drops names.

## Testing
No test suite yet. A quick headless check is to bundle or run (e.g. with `tsx`) a script that builds the scene, compiles the timeline, and seeks a `Player` to several times, then prints object positions.

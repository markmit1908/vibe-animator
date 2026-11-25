# CLAUDE.md

Interactive Three.js animation of refuelling a hex-block (HTGR-style) reactor core,
used to illustrate the concept. Delivered live in a browser.

## Layout (after the SolverKit migration)
- `app/` is the app (SolverKit: Home, vault, editor frame; see `app/CLAUDE.md`). The shared core is in `src/` and
  imported by the app; `src/studio/studio.ts` mounts it into the Studio view for one model (`StudioIO`: `edit`
  → ctx.edit autosave, `fileUrl` → `/api/files/<vault path>`, `assist` → SolverKit's key proxy).
- Animations are model files in the vault (`src/model/file.ts`); there is no `scenes/` or `scripts/` any more.

## Commands
- `npm run dev`: the app (server + web on :5174)
- `npm run typecheck`: `src/` and `app/`. Run it after every TS change.
- `npm run test:server`: the app server's pytest

## Architecture
- the model's `scene` → `src/scene/build.ts` → `BuiltScene` (registry of animatable objects by id, slots, columns, locations, clip planes)
- the model's `.anim` script → `src/script/anim.ts` → `src/timeline/compile.ts` → a flat list of `Tween`s and `StepEvent`s (label, cutaway)
- `src/timeline/player.ts`: `seek(t)` resets every registered object to its initial state and re-applies every tween up to t. It runs **every frame**, so playback is stateless and scrubbable. Never mutate animated state outside tweens.
- The compiler simulates a "virtual state" so each tween knows its from-value. `pick`/`place` expand into machine moves; the machine carries whatever it `held`s.
- Cutaway: shells are clipped with the shared `clipPlanes` (each material needs `clippingPlanes` and `clipIntersection: true`). Core blocks inside the cut region are hidden whole. This is reapplied after `seek` each frame.

- CAD (`scene.cad_models`, vault paths) is loaded **before** compiling (top-level await), so scripts can target CAD node ids (`<model>/<child>/…`).
- Player resets only `tl.touched` ids each frame. Visibility = not faded (script) AND not cut (cutaway) AND not `userData.userHidden` (tree toggle). Keep all three when touching `.visible`.

- Part state (`src/scene/state.ts`): working `state` = explicit `locked`/`hidden` flags by id (inherited by descendants) + `placements` (gizmo moves, local p/q). Named snapshots (flags + camera + placements) and groups live in the model file (`snapshots`, `groups`); `setStore` loads them, Save writes through `setStoreWriter` → `io.edit`. Lock/hide/placement changes autosave into the active snapshot (`persistWorking()` in studio.ts), as do group changes; the snapshot bar's Save also records the camera. `applyPlacements()` resets every registry object to `userData.homeP/homeQ`, then applies placements; Player captures script start positions after that. `reconcile()` in studio.ts applies them. Locked → `matrixAutoUpdate=false` (and `matrixWorldAutoUpdate=false` for fully locked subtrees). Locked + hidden CAD → `CadManager.suppress` frees geometry; `restore` reloads it from the .glb by id.
- User groups: `store.groups` (name → member ids, ancestor-covered members dropped), saved in snapshots.yaml, shared by all snapshots. Scripts expand `@name` in `resolveTargets`. Compiler virtual state is WORLD space (`getWorldPosition`); tweens convert to parent-local, assuming parents of moving parts are static.
- Changing locks recompiles the script. Scripts may not target locked objects.

- `scene.generated: false` in the model builds the parametric reactor and then drops it (lights and grid stay). The registry then holds CAD only. With no leading `camera` step the view frames everything loaded.

- `.anim` scripts: `src/script/anim.ts` (parser → engine actions, keeps source ranges), `src/view/scriptPanel.ts` (CodeMirror 6, SolverKit ModelText patterns), `src/script/edit.ts` (gizmo edits → text: update/add a line in the step at t, split the step if t is mid-step). Saved into the model (`io.edit`, autosaved). `buildTimeline()` seeks the old player to 0 before compiling (compile reads the start pose), then restores t. `Timeline.lines` maps script line → {start, end}.
- Rotation: world-space slerp about a pivot. The default pivot is the targets' bbox centre at their virtual pose; `pivot @x [p]` is stored in the first member's frame, so it follows the part. Don't move and rotate the same part in one parallel block (the last tween wins).

- AI assist: `src/assist/loop.ts` (manual streaming tool loop on `@anthropic-ai/sdk`, SolverKit's event protocol; model `claude-opus-5-5`, adaptive thinking, `fallbacks: "default"`, cached system prompt; tools use `eager_input_streaming` and are validated before running), `src/assist/system.ts` (system prompt – keep it stable for caching), `src/view/assistPanel.ts` (chat UI). The browser SDK talks to SolverKit's key proxy (`/api/assist/proxy`); the app server reads the key from the repo's `.env`. Never expose the key to the page. Every change the assistant makes is a proposal the user accepts. Read tools (`src/assist/tools.ts`): find_parts, get_part, get_tree, check_script (dry-run: seek 0, compile, restore t), screenshot (off-screen framed view, JPEG). Proposal tool `propose_script_edit` (full new script → `proposal` event with base text, compile check and errors); studio.ts renders the card (LCS line diff, Preview = compile the proposal into the player without touching the editor, Accept = `scriptPanel.setText`, warns if the script changed since `base`). `?debug=proposal` injects a sample card. `propose_groups` / `propose_state` (in `modelProposeTools`) validate against the scene; Accept calls `applyGroupChanges` / `applyStateChanges` in studio.ts (same semantics as the tree: ancestor-covered members dropped, explicit flags with descendants inheriting), marks the model unsaved, recompiles. `?debug=model-proposals` exercises both. The conversation persists in the model's `chat` (debounced). `?debug=assist` runs the read tools and dumps results into `<pre id=debug>` for headless checks.

- Hidden-line mode: `src/view/drawing.ts` – normal+depth pass (scene.overrideMaterial = MeshNormalMaterial with the cutaway clip planes; edge lines, outline hulls, sprites and the gizmo hidden for that pass) then a full-screen edge shader. `drawFrame()` in studio.ts picks shaded or drawing; PNG export renders one frame at 2× pixel ratio.


- Base colours: `model.colors` (id or @group → #hex). `applyColors()` in studio.ts clones the material per coloured mesh (`userData.baseMat0` keeps the original, `ownMat` set so the compiler doesn't clone again; respects the selection highlight's `origMat`). Changing them: seek 0, apply, `buildTimeline({ atStart: true })` (the old player's reset would overwrite the new colours). Script `color T #hex|reset [dur]` compiles to `highlight`; `reset` goes to the object's base colour (VState.base).

- Removed parts / display names: `model.removed` (ids) and `model.labels` (id → name), per animation. Removed objects get `userData.removed`: invisible (all visibility formulas include it), suppressed in `reconcile`, filtered from tree/assist, and `compile(..., isRemoved)` refuses them (groups skip removed members). Quick-fixes in `buildTimeline`: Restore (removed), Undo delete (`tree.lastDeletedGroup`), Unlock (locked). Group rename rewrites `@old` in the script via `onGroupRename` before the groups change.

- Targets: comma-separated lists (`a, b, @g`) parse to arrays; a target that isn't an id/glob/@group resolves by unique short name (last id segment) or label (`byName` in compile.ts; ambiguous → error). Pick mode: `ScriptPanel.updatePick` arms when the cursor is in a step's target position; tree `onSelect(…, clicked)` → `insertTarget(shortSpec(spec), add)`.

- Lists/loops: `list @x = …` (compile.ts `lists`, checked against tree groups) and `each T [stagger d] [order o] { … }`: compiled per item with `$` swapped for the id and `$i` as an expression var (vector components may be `{… $i …}`); only the first item records `Timeline.lines` (`recordLines`). Globs without `/` also match short names, natural-sorted.

## Conventions
- Y is up, units are metres, and the core base is at y = 0. The operating floor sits at the vessel flange (`floorY`), and locations are relative to it.
- The machine's origin is the grapple tip.
- Block ids are `R<ring>-<i>/L<n>`, with L0 at the bottom. Hex layout is axial, flat-top.
- Script expressions `{...}` are evaluated with `with(Math)`, so don't name script variables after Math functions (`floor`, `max`, …). The floor height variable is `floorY` for this reason.
- Look and feel: cel-shaded (MeshToonMaterial with a 3-band ramp), black background, black outlines, off-white plus a copper accent. Use the `toon()` helper in build.ts, not Lambert/Standard materials. Colours come from the model's `scene.palette`.
- All dimensions are currently placeholders until the user supplies real numbers.

## CAD
- `data/` holds raw CAD and is git-ignored. Never commit it; the plant STEP is 757 MB.
- `tools/step2gltf.py` (uv inline deps, cadquery-ocp, Python <3.13) has three commands: `tree`, `audit`, `convert`. Parsing the plant model takes about 3 minutes and 6 GB, so run it in the background.
- OCCT's glTF writer does not share meshes between instances, so `convert` re-instances baked copies (principal axes + vertex check), merges faces (one primitive per part), then runs `gltf-transform dedup`. Never use gltf-transform `instance`: it flattens the hierarchy and drops names.

## Testing
No test suite yet. A quick headless check is to bundle or run (e.g. with `tsx`) a script that builds the scene, compiles the timeline, and seeks a `Player` to several times, then prints object positions.

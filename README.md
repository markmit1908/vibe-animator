# Core Refuelling Animation

Interactive, browser-based animation of refuelling a hex-block reactor core.
Three.js + Vite + TypeScript. The model and the animation are both defined in
YAML, so you can change the geometry and choreography without touching code.

## Quick start

```bash
npm run dev        # the app on SolverKit: Python server (vault) + web on http://127.0.0.1:5174
npm run typecheck  # shared core (src/) and the app (app/)
npm run test:server
```

The app is built on **SolverKit** (`app/`): **Home** lists your animations (New, Duplicate, Rename, Delete to trash,
folders, versions, Import/Export). Each animation is one human-readable JSON file in the **vault**,
`~/Documents/Refuel animations` by default (Settings changes it). The 3D models (`.glb`) live in the vault's
`CAD/` folder and are **shared** between animations. Opening an animation shows the **Studio**: 3D view, assembly
tree, script editor and AI assist. Edits autosave, and SolverKit keeps versions.

**Importing old projects:** Home → Import accepts the old app's exported `.json`, and its `.zip`, whose 3D model goes into `CAD/`.

## Files

| Path | What it is |
|---|---|
| `app/` | The SolverKit app: `src/main.tsx` (manifest, Home), `src/module.tsx` (modules + the Studio view), `src/studio.tsx`, `src/importOld.ts`, `server/` (Python: vault-backed store, files, assist key proxy) |
| `src/model/file.ts` | The animation model file (SolverKit envelope, `solver: refuel-anim`, format 1) and `refuel-anim.schema.json` |
| `src/studio/studio.ts` | The studio: mounts 3D view, tree, script, assist into a container for one model |
| `src/scene/` | Scene build, CAD loading/suppression, part state (locks, hides, snapshots, groups) |
| `src/timeline/`, `src/script/` | `.anim` parser, compiler, player, edit write-back |
| `src/view/` | Tree, script panel, assist panel, drawing mode, triad, cutaway |
| `src/assist/` | Assist loop (Anthropic SDK over the server's key proxy), tools, system prompt |
| `tools/step2gltf.py` | STEP → glTF converter. Put its output in the vault's `CAD/` folder. |

## Script panel (`.anim`)

The panel sits on the right, under the controls:
- **Edit live:** each change recompiles. Errors are underlined on their line, and the last good version keeps playing.
- **Step times:** the left gutter shows when each step starts. **Click** a time to run to the end of that step, **drag** on it to scrub within the step, or press **⌘↵** to run to the cursor's step.
- **Write by direct manipulation:** pause at a time t > 0, select a part, group or multi-selection, then move (W) or rotate (E) it with the gizmo. The change is written into the step at t:
  an existing `move`/`rotate` line for that target is updated, otherwise a line is added (the step becomes `parallel { }`).
  If t falls mid-step, the step is **split** at t first. The `edit: by | to` toggle chooses relative or absolute values (default `by`).
  At t = 0 the gizmo sets the start pose instead (snapshot placements).
- **📷** inserts the current camera view as a step. Script edits autosave into the animation file.

Syntax reference: `src/script/anim.ts` (file header) and the assistant's system prompt (`src/assist/system.ts`).

## AI assist (Assist tab)

The **Assist** tab is a chat with Claude (`claude-opus-5-5`) that knows the script, the assembly tree, your groups,
selection and current time. It can look things up (find parts, read bounding boxes, browse the tree, compile a draft,
take a screenshot) and **propose** changes:
- **script edits:** a diff with a compile check, plus ▶ Preview (plays it without touching the editor), Accept and Reject
- **group changes**
- **lock / hide changes**

Nothing changes without **Accept**.
Chat controls: Stop (Esc), Edit a sent message, Regenerate, Copy, plus effort (low → xhigh) and New.
The conversation is saved in the animation file.

**Setup:** put the key in the repo's `.env` (git-ignored) as `ANTHROPIC_API_KEY=…` (or `VITE_ANTHROPIC_API_KEY`), then restart `npm run dev`.
The Python server reads it and SolverKit's assist proxy adds it to each request, so the key never reaches the page.

## Object ids (for scripts)

- Columns: `R<ring>-<index>`. `R0-0` is the centre column, and indices walk around each ring.
- Blocks: `<column>/L<n>`, numbered from `L0` at the bottom. The default stack is L0–1 bottom reflector, L2–9 fuel and L10–11 top reflector.
- Fresh blocks: `fresh/0` … `fresh/N-1`, staged on `fresh_rack`.
- Groups: `vessel`, `head`, `bolts`, `barrel`, `machine`.
- Globs: `R1-1/L*`.

## Script example

```yaml
- label: "Discharge spent fuel"
- repeat:
    var: i
    from: 9
    to: 2
    steps:
      - {highlight: "R1-1/L{i}", color: spent}
      - {pick: "R1-1/L{i}", dur: 4}
      - {place: {loc: spent_rack, dx: "{(9 - i) % 4 * 0.5}"}, dur: 4}
```

`pick` and `place` choreograph the machine for you: it travels at clearance
height, descends, grabs or releases, and rises again. `{expr}` inside strings is
evaluated with loop variables, macro args, `bh`, `floorY`, `clear` and Math
functions.

## Using CAD

Raw CAD goes in `data/` (git-ignored). Convert with `tools/step2gltf.py`
(OpenCASCADE via `uv`; the first run downloads it):

```bash
uv run tools/step2gltf.py tree    data/model.step --depth 5      # browse the assembly
uv run tools/step2gltf.py audit   data/model.step > data/audit.md  # naming/instancing problems
uv run tools/step2gltf.py convert data/model.step -o public/cad/model.glb \
    --include 'V-0100*' --exclude '*Screw*' '*Magnet*' --min-size 50 --deflection 2
```

`convert` merges each part's faces into one mesh and rebuilds instancing for copies baked in place. It then runs gltf-transform `dedup`, so identical parts share one mesh. The `instance` pass is not used because it flattens the assembly tree.
The converter keeps the assembly tree, part names and colours. It converts mm to m and Z-up to Y-up (use `--up y` if the model is already Y-up).
Reading a large STEP is slow: the 757 MB plant model takes about 3 minutes and 6 GB of RAM.

`audit` lists names shared by geometrically different parts, identical parts stored
as separate copies instead of instances, and unnamed, empty or surface-only parts.

1. Convert as above into `public/cad/`.
2. Reference it in the animation's `scene.cad_models` (vault path, e.g. `CAD/plant.glb`):
   ```yaml
   cad_models:
     - {id: plant, file: cad/plant.glb, up: x, ground: true, position: [16, 0, 0]}
   ```
   `up` corrects the model's up axis (`z` default, `x`, `-x`, `y`, `-y`). `ground: true` stands the model on `position`, centred.
3. Every node appears in the assembly tree and can be used in scripts as `plant/<child>/<grandchild>…`.
   Duplicate sibling names get `_1`, `_2`… suffixes (from Three.js's glTF loader). Ids are stable across reloads.

## Visual style

Cel-shaded "technical illustration" look: black background, three-band toon
shading, black outlines, off-white structure and a copper accent. Colours live
in the animation's `scene.palette`.

## Status / roadmap

- [x] Parametric hex core, vessel, head, machine
- [x] YAML timeline: pick/place, move, highlight, fade, camera, labels, repeat, macros
- [x] Cutaway (half/quarter), X-ray, chapters, scrubbing
- [ ] Real dimensions (all current values are **placeholders**)
- [ ] Section caps on clipped shells, 3D callout labels
- [x] Thick outlines on blocks and shells (inverted hull; `scene.outline_width`)
- [ ] Outlines for imported CAD
- [ ] Video export
- [x] STEP→glTF conversion script (`tools/step2gltf.py`)
- [x] glTF dedup pass (shared meshes; hierarchy kept)
- [x] Rebuild instancing for copies baked in place (Shapr3D)
- [x] Lock / hide / suppress parts from the assembly tree
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls)

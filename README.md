# Core Refuelling Animation

Interactive, browser-based animation of refuelling a hex-block reactor core.
Three.js + Vite + TypeScript. The model and the animation are both defined in
YAML, so you can change the geometry and choreography without touching code.

## Quick start

```bash
npm install
npm run dev        # open the printed URL; edits to YAML hot-reload
npm run build      # static site in dist/ (typecheck + bundle)
```

Controls: **Space** play/pause, drag to orbit (turns off the scripted camera),
GUI panel for speed, scrubbing, cutaway mode, X-ray shells and chapter jumps.

**View toolbar** (floating, top right of the viewport):
- **Shaded / Hidden line:** hidden line draws visible edges only, black on white. It's screen-space edge detection, so it works on the full plant, follows animation and cutaway, and the gizmo stays on top.
- **Iso / Front / Top / Side / Fit:** frame everything visible.
- **⤓ PNG:** saves the current view at 2× resolution.

URL: `?mode=hidden&view=iso`.

**Assembly tree** (left, ☰ toggles it): browse the generated model and loaded CAD,
search by name, and click a row or the part in 3D to select it (its script id is shown with a copy button).
Children are built when you expand a node and only on-screen rows are drawn, so trees of any size work.

- ● **show/hide**
- 🔒 **lock/unlock**: locked parts never move. They skip per-frame matrix updates and can't be used in scripts.
  CAD defaults to locked and the generated model to unlocked. Unlock what the animation moves.
- **Locked + hidden CAD parts are suppressed**: their geometry is freed from GPU and browser memory
  (shared meshes once no visible copy uses them). Showing them again reloads the geometry from the file.
- Flags are inherited by children from their parents.

**Snapshots** (bar at the top of the panel) are named model states: show/hide and lock flags, the camera view,
and part placements. Nothing is written until you press **Save** (or ⌘/Ctrl+S); "● unsaved" marks pending changes.
**Save as…** creates a new snapshot, the dropdown switches between them, and ✕ deletes one. They are stored in `scenes/snapshots.yaml`.

**Groups** are your own assemblies, separate from the CAD structure. ⌘/Ctrl/Shift-click to select several parts
(in the tree or in 3D), then press **Group…** and enter a new name, or an existing one to add to it. Groups are listed under
**Groups** in the tree; show/hide and lock apply to all members, and a group can be renamed or deleted, and members removed.
Scripts address a group as `"@name"`, e.g. `{move: "@lifting-rig", by: [0, 3, 0], dur: 4}`.
Groups are shared by all snapshots and saved with Save.

**Moving parts:** select an **unlocked** part to get a gizmo. **W** = move, **E** = rotate, **R** = reset to its original placement, **Esc** = deselect.
Parts the script animates can only be placed at t = 0 (that sets their start position).

The panel footer shows live GPU geometry, triangle and draw-call counts.
URL params: `?t=42` opens at 42 s, `?select=R1-1/L5` selects a part, `?debug` dumps CAD ids/stats into a hidden `<pre id=debug>`.

## Script panel (`.anim`)

Set `script: plant.anim` in `core.yaml`. The panel sits on the right, under the controls:
- **Edit live:** each change recompiles. Errors are underlined on their line, and the last good version keeps playing.
- **Step times:** the left gutter shows when each step starts. **Click** a time to run to the end of that step, **drag** on it to scrub within the step, or press **⌘↵** to run to the cursor's step.
- **Write by direct manipulation:** pause at a time t > 0, select a part, group or multi-selection, then move (W) or rotate (E) it with the gizmo. The change is written into the step at t:
  an existing `move`/`rotate` line for that target is updated, otherwise a line is added (the step becomes `parallel { }`).
  If t falls mid-step, the step is **split** at t first. The `edit: by | to` toggle chooses relative or absolute values (default `by`).
  At t = 0 the gizmo sets the start pose instead (snapshot placements).
- **📷** inserts the current camera view as a step. **⌘S** saves to `scripts/<name>.anim`.

Syntax reference: see the header of `scripts/plant.anim`.

## AI assist (Assist tab)

The **Assist** tab is a chat with Claude (`claude-opus-5-5`) that knows the script, the assembly tree, your groups,
selection and current time. It can look things up (find parts, read bounding boxes, browse the tree, compile a draft,
take a screenshot) and **propose** changes:
- **script edits:** a diff with a compile check, plus ▶ Preview (plays it without touching the editor), Accept and Reject
- **group changes**
- **lock / hide changes**

Nothing changes without **Accept**.
Chat controls: Stop (Esc), Edit a sent message, Regenerate, Copy, plus effort (low → xhigh) and New.
The conversation is saved beside the script as `scripts/<name>.chat.json`.

**Setup:** put a key from console.anthropic.com in `.env` as `ANTHROPIC_API_KEY=…` (git-ignored) and restart `npm run dev`.
The dev server proxies `/__assist` and adds the key server-side, so the key never reaches the page.
Don't prefix it `VITE_`: Vite can expose `VITE_` variables to browser code.

## Files

| Path | What it is |
|---|---|
| `scenes/core.yaml` | Model setup: `generated: true/false` (parametric placeholder reactor on/off), `script:`, core lattice, block sizes, vessel, head, machine, named locations, fresh-fuel staging, palette, CAD models |
| `scripts/*.yaml` | Animation scripts. `script:` in core.yaml picks one: `refuel.yaml` animates the generated reactor, `plant.yaml` is the CAD starter. Action reference is in refuel.yaml's header |
| `public/cad/` | Converted `.glb` files (git-ignored), listed under `cad_models:` in core.yaml |
| `src/scene/build.ts` | Generates geometry from `core.yaml` |
| `src/timeline/compile.ts` | Turns the script into tweens |
| `src/timeline/player.ts` | Deterministic playback and seeking |
| `src/view/cutaway.ts` | Section views |
| `src/view/tree.ts` | Assembly tree panel, selection, visibility |
| `src/scene/cad.ts` | Loads `cad_models`, restyles them, registers node ids |
| `src/main.ts` | Renderer, UI, main loop |

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
2. Add it to `core.yaml`:
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
in `palette:` in `core.yaml`.

## Status / roadmap

- [x] Parametric hex core, vessel, head, machine
- [x] YAML timeline: pick/place, move, highlight, fade, camera, labels, repeat, macros
- [x] Cutaway (half/quarter), X-ray, chapters, scrubbing
- [ ] Real dimensions (all current values are **placeholders**)
- [ ] Section caps on clipped shells, 3D callout labels
- [x] Thick outlines on blocks and shells (inverted hull; `outline_width` in core.yaml)
- [ ] Outlines for imported CAD
- [ ] Video export
- [x] STEP→glTF conversion script (`tools/step2gltf.py`)
- [x] glTF dedup pass (shared meshes; hierarchy kept)
- [x] Rebuild instancing for copies baked in place (Shapr3D)
- [x] Lock / hide / suppress parts from the assembly tree
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls)

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

**Assembly tree** (left, ☰ toggles it): browse the generated model and loaded CAD,
show or hide parts with ●, search by name, and click a row or the part in 3D to select it.
The selected part's script id is shown with a copy button.
URL params: `?t=42` opens at 42 s, `?select=R1-1/L5` selects a part.

## Files

| Path | What it is |
|---|---|
| `scenes/core.yaml` | Model setup: core lattice, block sizes, vessel, head, machine, named locations, fresh-fuel staging, palette, CAD models |
| `scripts/refuel.yaml` | Animation script (timeline + macros). Action reference is in the file header |
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

After writing, `convert` runs gltf-transform `dedup` + `instance`, so identical parts share one mesh and draw as GPU instances (`--no-optimize` skips this).
The converter keeps the assembly tree, part names and colours. It converts mm to m and Z-up to Y-up (use `--up y` if the model is already Y-up).
Reading a large STEP is slow: the 757 MB plant model takes about 3 minutes and 6 GB of RAM.

`audit` lists names shared by geometrically different parts, identical parts stored
as separate copies instead of instances, and unnamed, empty or surface-only parts.

1. Convert as above into `public/cad/`.
2. Add it to `core.yaml`:
   ```yaml
   cad_models:
     - {id: plant, file: cad/plant.glb, position: [0, 0, 0], rotation_deg: [0, 0, 0]}
   ```
3. Every node appears in the assembly tree and can be used in scripts as `plant/<child>/<grandchild>…`.
   Duplicate sibling names get a `#2`, `#3`… suffix. GPU-instanced parts (`×N`) move as one object.

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
- [x] glTF dedup + GPU instancing pass (gltf-transform, runs automatically in `convert`)
- [ ] Re-instance copies that the CAD export baked in place (Shapr3D)

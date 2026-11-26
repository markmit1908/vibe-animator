# Refuel Animation

Browser-based animations of refuelling a reactor core over CAD models, built on **SolverKit**.
Each animation is a short text script (`.anim`) over an assembly of parts. The script plays, scrubs, and can be edited
by hand, by direct manipulation, or with an AI assistant.

## Quick start

```bash
npm run dev          # Python server (vault) + web on http://127.0.0.1:5174
npm run typecheck    # shared core (src/) and the app (app/)
npm run test:server  # server tests;  cd app && npx playwright test   for the end-to-end suite
```

- **Home** lists your animations: New, Duplicate, Rename, Delete (to trash), folders, versions, Import/Export.
- **The vault:** each animation is one human-readable JSON file there, by default `~/Documents/Refuel animations` (change it in Settings).
- **3D models** (`.glb`) live in the vault's `CAD/` folder and are **shared** between animations, so duplicating an animation doesn't copy them.
- **Opening an animation** shows the **Studio**. Everything you change **autosaves**, and SolverKit keeps versions (clock icon).

**Old projects:** Home → **Import** reads the old app's exported `.json`. For its `.zip` (which includes the 3D model),
use the **Import old project (.zip)…** link on Home; the model goes into `CAD/`.

## The Studio

| Area | What it does |
|---|---|
| **Assembly** (left) | The part tree: groups, CAD assemblies, removed parts. Snapshot bar on top, info box at the bottom. |
| **3D view** (centre) | Orbit with the mouse, click parts to select them. View toolbar top right. XYZ triad bottom left. |
| **Controls** (right) | Play/pause (Space), speed, time, cutaway, X-ray, scripted camera, chapters. |
| **Script / Assist** (right, tabs) | The `.anim` editor, and the AI assistant. |

**View toolbar:**
- **Shaded / Shaded + outline / Hidden line:** hidden line draws visible edges only, black on white; shaded + outline draws those edges over the cel-shaded view. ⚙ sets line weight, crease angle, sensitivity and colours.
- **Cutaway** (Controls → View): **Caps** on/off and **Cap shade**; `script` follows the script; or choose half / quarter, which side it removes, and **Centre cut on selection**. **⤓ Insert this cut into the script** writes it as a `cutaway` line.
- **Iso / Front / Top / Side / Fit:** frame everything visible.
- **⤓ PNG:** saves the view at 2× resolution with a transparent background (no grid). In hidden-line mode the parts keep their white fill.

URL options: `?t=12` (open at 12 s), `?select=<id>`, `?mode=hidden`, `?view=iso`, `?tab=assist`.

### Assembly tree

Right-click a row for its menu. Select a row and press **F2** to rename or **Delete** to remove; ⌘/Ctrl/Shift-click selects several.

| Action | What happens |
|---|---|
| ● **Show / hide** | Hidden parts aren't drawn. |
| 🔒 **Lock / unlock** | Locked parts never move and can't be animated. CAD starts locked; unlock what the script moves. Locked + hidden CAD is unloaded from memory. |
| **Rename** | A part gets a **display name** (scripts keep using its id). Renaming a **group** also updates `@old` → `@new` in the script. |
| **Remove from assembly** | Takes a part out of *this* animation: hidden, unloaded, not animatable. The CAD file is untouched. Listed under **Removed** with **Restore**. |
| **Group…** | Makes a group (`@name`) from the selection, or adds to one. Delete group leaves its parts alone. |
| **Colour** (info box) | Base colour for the selection. Swatches offer the colours already in the model (yours first, then the CAD colours); the picker gives any colour. A second row is a **palette** built from a key colour (default `#cad1ee`; its **Palette** picker changes it): the key, complementary (180°), split complementary (150°, 210°), triadic (120°, 240°) and analogous (±30°). **Reset** goes back to the CAD colour. In the script, after `color TARGET ` the completion offers the same colours as swatches, and each `#hex` in the script has a chip; click it to choose again. A part's own colour wins over its group's. |
| **Copy id** | The id to use in scripts. |

**Snapshots** (bar at the top) are named start states: lock/hide flags, part placements and a camera view. Changes
save into the active snapshot automatically. **Save** also records the camera; **Save as…** makes a new snapshot.

**Tools** (floating bar, left of the 3D view): **Blank / Unblank** (**H**) hides the selected parts or shows them again; **Blank others** (**⇧H**) hides everything that isn't selected; **Show all** unblanks every part; **Select by name** (**F**) selects every part whose name contains the text you type (or matches a `*` glob), ready to blank, group or colour; **Set origin** (⊕) picks a new model origin: click a cylindrical face (its vertical axis, fitted from the mesh), then a flat face (its height); after you confirm, the CAD moves so that point is (0, 0, 0), and saved views and snapshot cameras move with it (absolute numbers in the script don't); **Views** saves the camera (position and target) under a name, goes back to it, or inserts `camera <name> 2s` into the script; **Group** (**G**) makes a group from the selection.

**Undo / redo:** **⌘/Ctrl+Z** and **⇧⌘Z** (or Ctrl+Y) undo colours, moves (gizmo), lock/hide, groups, renames, remove/restore and script changes made by the gizmo or an accepted AI proposal. While you're typing in the script, ⌘Z is the editor's own undo.

**Moving parts:** select an unlocked part, group or several parts to get a gizmo (**W** move, **E** rotate, **R** reset, **Esc** deselect).
- **At t = 0** it sets the start pose.
- **At t > 0** the change is written into the script at that time (see below).

## The script (`.anim`)

One step per line; steps run in sequence. `#` starts a comment. Durations: `2s`, `500ms`. A step without a duration is instant.

| Step | Example | Notes |
|---|---|---|
| `move` | `move @lid by [0,3,0] 6s ease` | `by` = relative (metres, Y up), `to [x,y,z]` = bounding-box centre to a point. Easing: `ease` (default), `linear`, `in`, `out`. |
| `rotate` | `rotate @lid by [0,0,90] 4s about [0,12,0]` | Degrees about world X/Y/Z. Pivot: bounding-box centre, `about [..]`, or a `pivot`. `to [..]` = absolute orientation. |
| `pivot` | `pivot @lid [0,12,0]` | A pivot that travels with the part for later rotations. |
| `hide` / `show` | `hide @shielding 1s` | |
| `blank` / `unblank` | `blank @lid 1s` · `unblank all` · `blank others @core 1s` | Hide / show; work on locked parts (they don't move them). `blank others` hides everything not in the target (reverse blank); `unblank all` shows everything the script blanked. |
| `fade` | `fade @bolts to 0.2 2s` · `fade @bolts 1s` | Opacity 0–1; without one it fades out. Faded to 0 = hidden. |
| `color` | `color @lid #2e86de 1s` · `color @lid reset 1s` | Change colour over time / back to the base colour. |
| `highlight` | `highlight @spent #c0392b 1s` | Like `color`; also takes palette names (`spent`, `fresh`, `fuel`). |
| `camera` | `camera [12,16,14] look [0,5,0] 3s` · `camera overview 2s` | Moves the camera over the time given (instant without one). A name is a view saved with **Views**. A leading instant `camera` sets the opening view. |
| `label` | `label "Remove lid" "Unbolt and lift"` | Chapter title (+ subtitle); listed under Chapters. |
| `cutaway` | `cutaway quarter` · `cutaway half -z at @reactor` · `cutaway half y at [0,8,0]` | `none`, `half`, `quarter`. Optionally the side removed (`x`, `-x`, `y` = top, `-y`, `z`, `-z`; a quarter takes two, e.g. `x -z`) and the centre: `at [x,y,z]` or `at TARGET` (its bounding-box centre). Defaults: `half x`, `quarter x z`, at the origin. Cuts CAD and shells. Cut faces are **capped** (inside faces drawn flat in the part's colour, darker; outlined in the line views); `nocap` at the end leaves that cut open. |
| `wait` | `wait 2s` | |
| `parallel { … }` | see below | The steps inside run together. |
| `list` | `list @layer3 = F1-*-3, F1-14-3, @bolts` | A named list, usable as `@layer3` after this line. |
| `each { … }` | see below | A loop over a list or group. |

**Targets** (`TARGET` above):
- a part's **id** (tree → Copy id)
- its **short name**, the last segment of the id (e.g. `F1-14-3`), or its **display name**, when only one part has it
- a group or list **`@name`**
- **`~text`**: every part whose name contains *text* (case-insensitive), e.g. `blank ~V-005202-001 1s`
- a **glob** with `*`: over short names (`F1-*-3`) or full ids (`R1-1/L*`)
- **several, comma-separated:** `move F1-14-3, F1-16-3, @lid by [0,.25,0] 1s`

**Parallel steps:**
```
parallel {
  move @lid by [4,0,0] 5s
  camera [8,14,6] look [2,10,0] 5s
}
```

**Lists and staggered loops:**
```
list @layer3 = F1-*-3
each @layer3 stagger 0.2s order ring {   # $ = the item, $i = its index (0, 1, 2…)
  move $ by [0, 1 + $i*0.05, 0] 1s       # lift
  fade $ to 0 0.5s                        # then vanish (stays hidden)
}
```
- **Timing:** item *i* starts at *i* × `stagger`, and runs the block in sequence. `stagger 0` runs all items at once; no `stagger` runs one after another. The loop ends when the last item finishes.
- **Order:** `order x|-x|y|-y|z|-z|ring|-ring|random` sorts the items (default: as listed). `ring` goes from the centre outwards.

**Editing the script:**
- **Live:** each change recompiles. Errors are underlined (hover for the message), and the last good version keeps playing. A fixable error puts its fix as a button in the script bar: **🔓 Unlock** (every locked part the script animates, loops included), **Restore part**, **Undo delete**. Click the error count to jump to the error.
- **Step times** in the left gutter: **click** to run to the end of a step, **drag** to scrub within it, **⌘↵** runs to the cursor's step.
- **🎯 Picking:** type a command (`move `, `fade `, `each `, `list @x = `…), then click parts in the tree or 3D view to insert them (⌘/Ctrl-click adds another, **Esc** stops).
- **Gizmo edits at t > 0:** they update the `move`/`rotate` line for that target in the step at t, or add one (the step becomes `parallel { }`). If t is mid-step, the step is **split** first. **edit: by | to** chooses relative or absolute values. Inside a loop, the edit becomes a new step after it.
- **📷** inserts the current camera view as a step.

## AI assist (Assist tab)

A chat with Claude (`claude-opus-5-5`). It sees the script (with step times and errors), the current time, selection,
groups, lock/hide state and the top of the assembly tree.

**What it can look up:** search parts, read bounding boxes and positions, browse the tree, compile a draft script, and take a screenshot.

**What it can propose,** always as a card you **Accept** or **Reject**:
- **script edits:** a diff with a compile check and **▶ Preview**. Accept also unlocks every locked part the new script animates (listed on the card).
- **groups:** create, add, remove, delete.
- **part state:** lock/unlock, hide/show, base colours, remove/restore.

The panel is SolverKit's Assist panel: Send/Stop (Esc gives the prompt back), Edit in place, Regenerate, Copy, **Clear**, and an **Accept all / Reject all** queue of waiting changes. Every code block in a reply has **Insert into script**; **Effort** sets how hard the model thinks (default *low*, the fastest; use medium/high for harder requests). Script changes are proposed as small edits (only the changed lines are sent), shown as a full diff.
The conversation is saved in the animation file.

**Setup:** put the key in the repo's `.env` (git-ignored) as `ANTHROPIC_API_KEY=…` (or `VITE_ANTHROPIC_API_KEY`) and
restart `npm run dev`. The server reads it and SolverKit's assist proxy adds it to requests; the key never reaches the page.

## Using CAD

Raw CAD goes in `data/` (git-ignored). Convert it with `tools/step2gltf.py` (OpenCASCADE via `uv`; the first run downloads it):

```bash
uv run tools/step2gltf.py tree    data/model.step --depth 5          # browse the assembly
uv run tools/step2gltf.py audit   data/model.step > data/audit.md    # naming/instancing problems
uv run tools/step2gltf.py convert data/model.step -o ~/Documents/Refuel\ animations/CAD/model.glb \
    --exclude '*Screw*' --min-size 50 --deflection 2
```

What `convert` does:
- **Multi-body parts** are split into named bodies (e.g. `F1-14-3`).
- **Copies baked in place** are re-instanced, faces merged per part, and identical meshes shared.
- **The assembly tree, names and colours** are kept.
- **Units and axes:** converts mm → m and Z-up → Y-up (`--up y` if the model is already Y-up).

Reading a large STEP is slow: the 757 MB plant takes about 3 minutes and 6 GB of RAM.

To use the result, put the `.glb` in the vault's `CAD/` folder and reference it in the animation's `scene.cad_models`:
```json
"cad_models": [{ "id": "plant", "file": "CAD/plant.glb", "up": "y", "ground": true, "position": [0, 0, 0] }]
```
`up` corrects the model's up axis (`z`, `x`, `-x`, `y`, `-y`), and `ground: true` stands it on `position`, centred.
Every node appears in the tree with an id `plant/<child>/…`; duplicate sibling names get `_1`, `_2`… suffixes.

## Files

| Path | What it is |
|---|---|
| `app/` | The SolverKit app: `src/main.tsx` (manifest, Home), `src/module.tsx` (modules, Studio view), `src/studio.tsx`, `src/importOld.ts`, `src/help.md`, `server/` (vault store, files, assist key proxy), `e2e/` |
| `src/model/file.ts` | The animation file format (SolverKit envelope, `solver: refuel-anim`, format 1) and its JSON schema |
| `src/studio/studio.ts` | The Studio: mounts the 3D view, tree, script and assist for one animation |
| `src/scene/` | Scene build (incl. the generated placeholder reactor), CAD loading/suppression, part state |
| `src/script/`, `src/timeline/` | `.anim` parser, compiler, player, gizmo write-back |
| `src/view/` | Tree, script panel, assist panel, hidden-line mode, triad, cutaway |
| `src/assist/` | Assist loop (Anthropic SDK over the key proxy), tools, system prompt |
| `tools/step2gltf.py` | STEP → glTF converter |

## Status / roadmap

- [x] SolverKit app: Home, vault, versions, autosave
- [x] `.anim` scripts: live editing, gizmo write-back, picking, lists and staggered loops
- [x] Assembly: lock/hide/suppress, groups, colours, rename, remove/restore, snapshots
- [x] AI assist with proposals; hidden-line drawing; PNG export
- [x] STEP → glTF with multi-body splitting and re-instancing
- [ ] Real dimensions for the placeholder reactor
- [x] Section caps on cut parts
- [ ] 3D callout labels, outlines for imported CAD
- [ ] Video export
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls)

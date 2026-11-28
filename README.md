# Refuel Animation

Browser-based animations of refuelling a reactor core over CAD models, built on **SolverKit**.
Each animation is a short text script (`.anim`) over an assembly of parts. The script plays, scrubs, and can be edited
by hand, by direct manipulation, or with an AI assistant.

## Setup (first time)

The app is built on [SolverKit](https://github.com/markmit1908/vibe-solverkit), used from a checkout **next to this
repo**: `app/package.json` links its packages from `../../vibe-solverkit/packages/*`, and the server installs its Python
package from `../../vibe-solverkit/python`. You need access to that repository.

**Needs:** Node 20+, Python 3.12 via [uv](https://docs.astral.sh/uv/) (`brew install uv`), git. pnpm runs through `npx`.

```bash
mkdir -p ~/dev && cd ~/dev                      # any folder – the two repos must be siblings
git clone https://github.com/markmit1908/vibe-solverkit.git
git clone https://github.com/markmit1908/vibe-animator.git

# 1. SolverKit: install and build its packages (the app uses their dist/ builds)
cd vibe-solverkit
npx -y pnpm@9.15.9 install
npx -y pnpm@9.15.9 build

# 2. This repo: the shared core's packages (three, CodeMirror, the Anthropic SDK…)
cd ../vibe-animator
npm install

# 3. Run it – the first run also creates app/.venv (SolverKit's Python server) and installs the app's packages
npm run dev                                       # http://127.0.0.1:5174
```

```
~/dev/
├── vibe-solverkit/     SolverKit (packages/*, python/)
└── vibe-animator/      this repo (src/ = 3D core, app/ = the SolverKit app)
```

**AI assist (optional):** put your key in this repo's `.env` (git-ignored): `ANTHROPIC_API_KEY=sk-ant-…`. See
[AI assist](#ai-assist-assist-tab).

**After pulling SolverKit changes:** rebuild it (`cd ../vibe-solverkit && npx -y pnpm@9.15.9 build`), then restart
`npm run dev`. If its Python package changed, delete `app/.venv` and the next `npm run dev` recreates it.

**End-to-end tests:** once, `cd app && npx playwright install chromium`; then `npx playwright test` (a fresh temporary
vault; your own animations aren't touched).

**Your animations** live in the vault (`~/Documents/Refuel animations` by default), not in this repo – copy that folder
(including `CAD/`) to move them to another machine.

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
| **Animation / Illustration / AI Assist** (right, tabs) | Animation: the controls and the `.anim` editor. Illustration: drawing sheets (SVG). AI Assist: the assistant. |

**View toolbar:**
- **Shaded / Shaded + outline / Hidden line** (*outline* here means the drawn edges; the script's `outline` step is a glow around chosen parts): hidden line draws visible edges only, black on white; shaded + outline draws those edges over the cel-shaded view. Lines are anti-aliased: silhouettes/outlines (against the background or a part behind) and edges (creases, and the boundary wherever two parts touch) have their own weights in ⚙, with crease angle, outline sensitivity and colours. ⚙ sets line weight, crease angle, sensitivity and colours.
- **Cutaway** (Controls → View): **Caps** on/off and **Cap shade**; `script` follows the script; or choose half / quarter, which side it removes, and **Centre cut on selection**. **⤓ Insert this cut into the script** writes it as a `cutaway` line.
- **Keep uncut:** parts the cut leaves whole, saved with the animation and applied to every cut (the Controls' and the script's): ✂ **Keep uncut** on the tool bar (**K**; **Cut again** when the selection is kept), right-click **Keep uncut** in the tree (kept rows show ✂, dimmed when kept through an assembly), or **Controls → View → Kept uncut** (*Keep selection uncut*, *Cut selection again*, *Clear*). Kept parts are drawn whole and solid, aren't capped, and kept core blocks stay visible. A script cut can keep more for that cut only: `cutaway half x keep @lid, machine`.
- **Iso / Front / Top / Side / Fit:** frame everything visible.
- **⤓ PNG:** saves the view at 2× resolution with a transparent background (no grid). In hidden-line mode the parts keep their white fill.

URL options: `?t=12` (open at 12 s), `?select=<id>`, `?mode=hidden`, `?view=iso`, `?tab=assist`.

### Assembly tree

Right-click a row for its menu. Select a row and press **F2** to rename or **Delete** to remove; ⌘/Ctrl-click adds or removes a row; **Shift**-click selects the range from the last row clicked (⌘/Ctrl+Shift adds the range). In the 3D view, ⌘/Ctrl/Shift-click adds a part, and **Shift-drag** draws a selection box: left → right (window) picks the parts wholly inside, right → left (crossing) also those it touches – including parts behind others, not blanked or removed ones; ⌘/Ctrl + Shift-drag adds.

| Action | What happens |
|---|---|
| ● **Show / hide** | Hidden parts aren't drawn. |
| 🔒 **Lock / unlock** | Locked parts never move and can't be animated. CAD starts locked; unlock what the script moves. Locked + hidden CAD is unloaded from memory. |
| **Rename** | A part gets a **display name** (scripts keep using its id). Renaming a **group** also updates `@old` → `@new` in the script. |
| **Remove from assembly** | Takes a part out of *this* animation: hidden, unloaded, not animatable. The CAD file is untouched. Listed under **Removed** with **Restore**. |
| **Group…** | Makes a group (`@name`) from the selection, or adds to one. Delete group leaves its parts alone. |
| **Folders** | Groups can be filed in folders (and folders in folders) to keep the Groups section tidy: right-click **Groups** or a folder → **New folder…**, then drag groups or folders onto a folder (or onto **Groups** for the top level), or use **Move to folder…** (`a/b` makes nested folders). Clicking a folder selects all its groups' parts; its ● and 🔒 show/hide and lock them all; a colour set on a folder goes on each of its groups. Deleting a folder moves its contents up a level. Folders are for the tree only – scripts use the groups. |
| **Colour** (info box) | Base colour for the selection. Swatches offer the colours already in the model (yours first, then the CAD colours); the picker gives any colour. A second row is a **palette** built from a key colour (default `#cad1ee`; its **Palette** picker changes it): the key, complementary (180°), split complementary (150°, 210°), triadic (120°, 240°) and analogous (±30°). **Reset** goes back to the CAD colour. In the script, after `color TARGET ` the completion offers the same colours as swatches, and each `#hex` in the script has a chip; click it to choose again. A part's own colour wins over its group's. |
| **Copy id** | The id to use in scripts. |

**Snapshots** (bar at the top) are named start states: lock/hide flags, part placements and a camera view. Changes
save into the active snapshot automatically. **Save** also records the camera; **Save as…** makes a new snapshot.

**Tools** (floating bar, left of the 3D view):

| Tool | What it does |
|---|---|
| **Blank / Unblank** (**H**) | Hides the selected parts, or shows them again |
| **Blank others** (**⇧H**) | Hides everything that isn't selected (reverse blank) |
| **Keep uncut** (**K**) | Cuts leave the selection whole (saved; **Cut again** undoes it) |
| **Show all** | Unblanks every part |
| **Select by name** (**F**) | Selects every part whose name contains the text you type (or matches a `*` glob) – then blank, group or colour them |
| **Set origin** (⊕) | Click a cylindrical face (its vertical axis, fitted from the mesh), then a flat face (its height); after you confirm, the CAD moves so that point is (0, 0, 0). Saved views and snapshot cameras move with it; absolute numbers in the script don't |
| **Duplicate** (⧉, ⌘D) | A linked copy of the selected parts / assemblies / group (model `copies`), made in place and selected in Move mode – drag it away: shares and follows the source geometry, own position (its centre, m) and rotation (°), mirror (x/y/z) and a linear or circular array (members `pump-1-0`…) in the Copy panel (right-click the copy in the tree → **Edit copy…**; ✕ / Esc closes it), or moved with the gizmo; listed under **Copies**. Scripts: the copy's name (`pump-1`); parts inside it by full id (`copies/pump-1/<source id>`). Removing a source part removes it from its copies |
| **Move** / **Rotate** (W / E) | The gizmo's mode for the selection (a part, several, a group – on their centre); works on locked CAD at t = 0. Alt/Option held: rotate in 15° steps. ⌘-drag (Ctrl-drag off the Mac) drags out a linked copy |
| **Annotate** (✎) | A title + note about the selection (parts, a group or a folder – model `annotations`), with a leader to a picked point that follows its part; drag / double-click / Delete on the card; folder and group renames keep them attached. **✎ Notes** in the tree's header adds a Notes column to the tree: each row shows the note made on that part / solid / group / folder (checkbox + title, +N); click to edit in place, an empty cell adds one, clearing deletes, double-click opens its card; the bar under the header has Show notes in the view and ⤓ CSV. **✎ Notes** on the view bar is the same all-on / off switch, in the 3D view. A hidden part (blanked, removed, cut away) hides its annotation whatever its checkbox says; the assistant reads them (`get_annotations`) and proposes changes (`propose_annotations`) |
| **Remove** / **Keep only** | Remove the selected parts from the animation, or keep only them (everything else removed: the fewest top-level pieces); Restore under **Removed**, one ⌘Z |
| **CAD** (📦) | Load / upload / remove `.glb` models; per model a position (m) and a turn about the vertical (°), live; **✂ Slim** writes `CAD/<name>-slim.glb` without the parts removed here (removed nodes kept as empty placeholders, so ids stay) and switches to it |
| **Align** (⊟) | Line the selection's box up with another part's (typed or ⌖ picked): per axis min / centre / max, on, under, plus a gap; presets Sit on top, Centre on, Under, Beside +x. Sets the start pose (shapes / copies: their numbers; other parts: a placement); undoable |
| **Gizmo snap** (Controls) | Move step (off … 1 m) and rotate step (off … 90°, default 15°) for the gizmo |
| **Shape** (◇) | Basic modelling: add a box, cylinder, tube, sphere, cone, plane or hex prism – sizes, position, rotation, colour, and a linear or circular array (e.g. a bolt circle). Select a shape to edit it (changes apply as you type); Duplicate, Delete. Shapes are listed under **Shapes** in the tree, start unlocked, and cut, cap and outline like CAD |
| **Thumbnail** (📌) | This moment (time, camera, view style) becomes the card image on Home, re-rendered as the animation changes. A `thumbnail` script step wins; without either, the card is the opening frame |
| **Views** (📷) | Saves the camera (position and target) under a name, goes back to it, or inserts `camera <name> 2s` into the script |
| **Group** (**G**) | Makes a group (`@name`) from the selection |


**Undo / redo:** **⌘/Ctrl+Z** and **⇧⌘Z** (or Ctrl+Y) undo colours, moves (gizmo), lock/hide, groups and folders, keep uncut, shapes, renames, remove/restore and script changes made by the gizmo or an accepted AI proposal. While you're typing in the script, ⌘Z is the editor's own undo.

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
| `outline` | `outline @lid` · `outline @lid #ff3b30 12px 0.5s` · `outline machine, @bolts orange` · `outline @lid off 1s` | A glow around the parts to point them out: colour (`#hex` or a name; default cyan `#00e5ff`), width (1–40 px, default 8), fading in / out over the duration. It shows through parts in front, and a hidden part gets a faint tint of the colour, so buried parts can be found. Works on locked parts, in every view and in PNG export; follows the cut and blanking. |
| `highlight` | `highlight @spent #c0392b 1s` | Like `color`; also takes palette names (`spent`, `fresh`, `fuel`). |
| `camera` | `camera [12,16,14] look [0,5,0] 3s` · `camera overview 2s` | Moves the camera over the time given (instant without one). A name is a view saved with **Views**. A leading instant `camera` sets the opening view. |
| `label` | `label "Remove lid" "Unbolt and lift"` | Chapter title (+ subtitle); listed under Chapters. |
| `cutaway` | `cutaway quarter` · `cutaway half -z at @reactor` · `cutaway half y at [0,8,0]` | `none`, `half`, `quarter`. Optionally the side removed (`x`, `-x`, `y` = top, `-y`, `z`, `-z`; a quarter takes two, e.g. `x -z`) and the centre: `at [x,y,z]` or `at TARGET` (its bounding-box centre). Defaults: `half x`, `quarter x z`, at the origin. Cuts CAD and shells. Cut faces are **capped** (inside faces drawn flat in the part's colour, darker; outlined in the line views); `nocap` leaves that cut open. `keep TARGETS` leaves those parts whole for this cut, as well as the animation's **Keep uncut** list (e.g. `cutaway half x keep @lid, machine`). |
| `wait` | `wait 2s` | |
| `annotate` | `annotate all off` · `annotate @pumps on 1s` · `annotate "Tank T-1" off` | Show / hide annotations (fading over the duration): by target (the same target, or any whose parts overlap it), by `"Title"`, by id (`a1`) or `all`. With no `annotate` steps, annotations show as set in the list. Start with `annotate all off` to reveal them one by one. |
| `thumbnail` | `thumbnail outline` | This moment is the card image on Home (`shaded`, `outline`, `hidden`; default shaded). Wins over the Thumbnail button. |
| `parallel { … }` | see below | The steps inside run together. |
| `list` | `list @layer3 = F1-*-3, F1-14-3, @bolts` | A named list, usable as `@layer3` after this line. |
| `each { … }` | see below | A loop over a list or group. |

**Targets** (`TARGET` above):
- a part's **id** (tree → Copy id)
- its **short name**, the last segment of the id (e.g. `F1-14-3`), or its **display name**, when only one part has it
- a **shape** by its name (`pipe`); an array's copies are `bolt-0`, `bolt-1`… (`bolt-*` for all of them)
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

## Illustration (drawing sheets)

The **Illustration** tab makes print-quality vector line drawings (SVG) from the geometry, not from screen pixels.
Hidden lines are removed exactly, line weights are in mm at a chosen paper size and scale, and each line type is
its own layer (`outline` 0.5, `crease` 0.25, `hidden` 0.18 dashed, `hatch` 0.18, `annotations`, `border`, `titleblock`; weights as in ISO 128). Views are orthographic.

- **Controls:** paper, scale, hidden lines and crease angle for **⤓ Export SVG**, which draws the current view.
- **Drawing script** (`.draw`, saved with the animation): each `sheet` is one drawing. Settings before the first sheet
  are defaults. **▶ Preview** renders every sheet fast as a PNG and shows them (below; SVG / PDF of a sheet from there).
  **⤓ Save all** draws every sheet into the vault as `Drawings/<animation>/<file>.svg`, `.pdf` (vector, at the paper
  size) and `.png`. Long jobs show a progress card at the bottom left. Drawing a sheet never changes the studio's
  own view, pose or cut.

```
paper A1 landscape        # A0–A4, landscape | portrait
scale 1:50                # or: scale fit
hidden off                # dashed hidden lines (busy on big assemblies: use with `only`)
crease 30                 # crease angle, degrees
hatch 2.5                 # section hatch spacing in mm, or: hatch off
fill tint                 # part fills under the lines: off | tint (lightened) | colour
style outline             # the fast PNG: shaded | outline | hidden (the SVG is always lines)
annotate on               # annotation callouts: leader + boxed title (layer `annotations`); off by default
dpi 150                   # the PNG's resolution

sheet core-section "Core – half section"
  view front              # iso front back top bottom side left right, a saved view, or [dx, dy, dz]
  snapshot "refuel-start" # pose from a snapshot
  at 12.5s                # …and/or the animation at a time, or at "Chapter label"
  cut half x at [0,0,0]   # none | half [side] | quarter [side side]; default: the animation's cut at that time
  hide @building, ~bolt   # parts left out (ids, globs, @groups, names, ~text)
  only @core              # draw just these
  title "Core – half section A-A"   # the drawing name, in the title box (or quoted after `sheet`)
  file core-section-AA    # export file name: core-section-AA.svg / .pdf (default: the sheet name)
```

**▶ Preview** renders every sheet fast – one GPU frame each, in the sheet's `style` – saves `<file>.png` to the vault and shows them: a strip of thumbnails with the cursor's sheet large. While it's open, editing a sheet re-renders it live (≈0.3 s after you stop typing; not saved) and moving the cursor into a sheet shows it. ⤓ SVG / ⤓ PDF there make that sheet's exact drawing; **Save all** writes SVG, PDF and PNG for every sheet.

**Batch** (the app must be running – `npm run dev`): `npm run drawings -- "<animation>" [sheet …]` saves the sheets
(SVG + PDF) the same way, headless; `npm run drawings -- --all` does every animation with sheets; `--url` points at
another server. It exits 1 if a sheet has an error.

Cut faces are capped (what's inside a cut part stays hidden), outlined and hatched at 45° on the paper (135° for every other part). Fills (layer `fill`, under the lines) use the parts' base colours; their edges are traced at 0.25 mm on the paper and sit under the exact lines. The title box (lower right) is a plain rectangle with the drawing name and the scale (NTS when fitted); `titleblock off` leaves it out. A big assembly takes a few seconds per sheet
(the plant model: 8M triangles, 6–8 s).

## AI assist (AI Assist tab)

A chat with Claude (`claude-opus-5-5`). It sees the script (with step times and errors), the current time, selection,
groups (and their folders), shapes, copies, annotations, the palette (named colours + the palette swatches), the base colours set and the colours in use, lock/hide state and the top of the assembly tree.

**What it can look up:** search parts (also by colour: `#rrggbb`, off-palette, set / unset), read bounding boxes, positions and colours (shown, and the base colour set with where it comes from), browse the tree, compile a draft script, and take a screenshot.

**What it can propose,** always as a card you **Accept** or **Reject**:
- **script edits:** a diff with a compile check and **▶ Preview**. Accept also unlocks every locked part the new script animates (listed on the card).
- **groups:** create, add, remove, delete.
- **part state:** lock/unlock, hide/show, base colours, remove/restore.
- **positions:** place parts in the model – their start position for the whole animation, like dragging them with the gizmo at t = 0 (the script is untouched): move by an offset, move to a point (*“stand the machine on the vessel”* puts its bottom-centre on the vessel's top), rotate about an axis, or put parts back where the CAD has them. Works on locked parts; the card shows the box before and after.
- **shapes:** make, change (including rename, sizes, position, rotation, colour, arrays) or delete studio shapes – e.g. *“a 6 m tube, 300 mm bore, 600 mm OD, standing on the floor”*. The card lists each shape's sizes and position; once accepted the shape is in the tree and can be animated by name (ask for the script steps after).

The panel is SolverKit's Assist panel: Send/Stop (Esc gives the prompt back), Edit in place, Regenerate, Copy, **Clear**, and an **Accept all / Reject all** queue of waiting changes. Every code block in a reply has **Insert into script**; **Effort** sets how hard the model thinks (default *low*, the fastest; use medium/high for harder requests). Script changes are proposed as small edits (only the changed lines are sent), shown as a full diff.
The conversation is saved in the animation file.
While a reply runs, its cards already have **Accept now** / **Reject** (applied at once, not again at the end), and **Stop** keeps the cards made so far; a reply whose connection goes quiet for 2 minutes ends with a message, keeping its cards (these three work around SolverKit's panel – `solverkit-candidate`). It can propose linked copies and annotations on them in one turn (the annotations attach once the copies are accepted).

**Logs:** every send writes `Logs/assist/<animation>/<date time>.jsonl` in the vault – the prompt, context, each request, every content block whole (thinking, text, tool input), tool calls and results with timings, proposals, usage, stop reasons, stalls, errors and aborts, each event handed to the panel (and the panel's slow pickups), a `final_message` per round, and a heartbeat every 5 s (waiting for the API or for the panel, and for how long) – flushed every 2 s while the reply runs (one upload at a time, the newest content, 20 s timeout), so a stuck one still leaves its log. A reply the panel stops reading for 60 s is closed from the app's side (its Stop pressed; prompt, reply and cards put back in the chat). The server appends each proxied API request to `Logs/assist/proxy.jsonl` (the send it belongs to, status, time to first byte, bytes, duration, outcome). Neither holds the API key.

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

**Very big files: `--split`.** OCCT loads the whole file, so multi-GB exports run out of memory. `--split` doesn't:
```bash
uv run tools/step2gltf.py convert huge.step -o ~/Documents/Refuel\ animations/CAD/huge.glb --deflection 2 --split -v
```
1. **Index:** one streaming pass over the STEP text (no OCCT): every record's offset and type, plus the
   assembly tree, placements, part and body names, colours.
2. **Copies:** Shapr3D writes every copy of a body as separate geometry. Bodies with the same name (an `-N` / `_N`
   instance suffix ignored) and the same face and point counts are checked by solving the rigid transform between
   their geometry points (`--match-tol`, 0.05 mm); a confirmed copy isn't converted again, it instances the first.
3. **Convert:** the rest goes in units of at most `--budget` MB of STEP text (default 200 → about 2 GB each),
   each a small standalone STEP converted by a child process; `--jobs` at once (default: what fits in 60% of RAM).
4. **Merge:** one `.glb` with the full tree, the same names and node layout as `convert` gives.

A progress bar shows each phase (index, bodies, copies, convert, merge) with an ETA; `-v` also logs every unit and
the biggest groups of copies. `--include` / `--exclude` / `--min-size` work as above; `--keep-temp` keeps the units.
On the plant it takes 1 minute (vs 6) and matches the normal conversion.

To use the result, load it in the Studio with the **CAD** tool (📦): pick a `.glb` from the vault's `CAD/` folder, or upload one from disk (it is copied into `CAD/`). A new, empty animation offers this in the middle of the view. This writes the animation's `scene.cad_models`:
```json
"cad_models": [{ "id": "plant", "file": "CAD/plant.glb", "up": "y", "ground": true, "position": [0, 0, 0] }]
```
`up` corrects the model's up axis (`z`, `x`, `-x`, `y`, `-y`), and `ground: true` stands it on `position`, centred.
Every node appears in the tree with an id `plant/<child>/…`; duplicate sibling names get `_1`, `_2`… suffixes.

## Files

| Path | What it is |
|---|---|
| `app/` | The SolverKit app: `src/main.tsx` (manifest, Home), `src/module.tsx` (modules, Studio view), `src/studio.tsx` (mounts the studio; card images), `src/assist.tsx` (SolverKit's AssistPanel + our proposal cards), `src/importOld.ts`, `src/help.md`, `server/` (vault store, files, assist key proxy), `e2e/` (Playwright suite) |
| `src/model/file.ts` | The animation file format (SolverKit envelope, `solver: refuel-anim`, format 1) and its JSON schema |
| `src/studio/studio.ts` | The Studio: 3D view, tree, script, assist, tools bar, undo, thumbnails – for one animation |
| `src/scene/` | Scene build (incl. the generated placeholder reactor), CAD loading/suppression, part state, origin fitting, shapes (`shapes.ts`) |
| `src/script/`, `src/timeline/` | `.anim` parser, compiler, player, gizmo write-back |
| `src/view/` | Tree (groups, folders), script panel, hidden-line drawing (`drawing.ts`), section caps (`caps.ts`), cutaway and keep-uncut (`cutaway.ts`), outline glows (`glow.ts`), palette, triad |
| `app/scripts/drawings.mjs` | `npm run drawings`: headless batch drawings (Playwright) |
| `src/drawing/` | Vector line drawings: mesh collection and cutaway clipping (`collect.ts`), feature edges (`edges.ts`), exact hidden-line removal (`hlr.ts`, with a depth pre-pass `zbuffer.ts`), the SVG sheet writer (`svg.ts`), fills (`fills.ts`), sections (`sections.ts`), PDF (`pdf.ts`), the `.draw` parser (`script.ts`); its editor is `src/view/drawPanel.ts` |
| `src/assist/` | Assist loop (Anthropic SDK over the key proxy), read and proposal tools (script, groups, part state, shapes, positions), system prompt, the host interface for the panel |
| `tools/step2gltf.py` | STEP → glTF converter |
| `tools/stepindex.py`, `tools/stepsplit.py` | `convert --split`: streaming STEP index; copies, parallel units, merge |
| `TODO.md` | Open work |

## Status / roadmap

- [x] SolverKit app: Home, vault, versions, autosave, card thumbnails from a keyframe
- [x] `.anim` scripts: live editing, context-sensitive completion, gizmo write-back, picking, lists and staggered loops
- [x] Assembly: lock/hide/suppress, groups in folders, range selection, colours and palette, rename, remove/restore, snapshots, undo/redo
- [x] Tools bar: blank / blank others / show all, select by name, set origin, camera views, thumbnail
- [x] Basic modelling: box, cylinder, tube, sphere, cone, plane, hex prism; linear / circular arrays
- [x] Outlines: a glow around parts, seen through others (script `outline`)
- [x] Cutaways with sections (side, centre), section caps and parts kept uncut; hidden-line and shaded + outline views; PNG export
- [x] AI assist (SolverKit's panel) with proposals
- [x] STEP → glTF with multi-body splitting and re-instancing
- [ ] Real dimensions for the placeholder reactor
- [ ] Extrude / boolean modelling, video export, 3D callout labels – see `TODO.md`

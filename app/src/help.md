# Refuel Animation

Animations of reactor refuelling over CAD models. Each animation is one file in your vault
(`~/Documents/Refuel animations` by default). The 3D models (.glb) live in the vault's `CAD/` folder and are shared
between animations. Everything you change in an animation saves automatically; the clock icon shows its versions.

# Home

New, Duplicate, Rename, Delete (to the trash), folders and versions for your animations. A **New model** starts empty: load its 3D model with the **CAD** tool (📦) in the Studio.
- **Import** reads an animation file, or an old project's `.json`.
- **Import old project (.zip)…** reads an old project together with its 3D model.

# The Studio

- **Assembly** (left): the part tree.
- **3D view** (centre): orbit with the mouse, click parts to select them.
- **Controls** (right): play/pause (**Space**), speed, time, cutaway (and **Kept uncut**), chapters.
- **Script / Assist** (tabs under the controls).

**View toolbar:**
- **Shaded / Shaded + outline / Hidden line:** ⚙ sets the line style (both line views): **Silhouette weight** (outlines) and **Edge weight** (creases, and where parts touch) separately, crease angle, outline sensitivity, colours.
- **Iso / Front / Top / Side / Fit**
- **⤓ PNG:** 2× resolution, transparent background

# Cutaway

**Controls → View → Cutaway**: `script` follows the script's `cutaway` steps; or pick half / quarter to look at a cut now.
- **Half removes / Quarter removes**: which side(s) are cut away.
- **Centre cut on selection** (or on the origin): where the cut is.
- **Caps**: cut faces are filled in each part's colour, darker (**Cap shade**). Off, or `nocap` in the script, shows the hollow insides.
- **⤓ Insert this cut into the script** writes it as a `cutaway` line.
- **Keep uncut** (✂ on the tool bar, **K**; right-click in the tree; or **Kept uncut** here): every cut leaves those parts whole. In the script, `keep` adds parts for one cut: `cutaway half x keep @lid, machine`.

# Outlines

A glow around parts to point them out, from the script:
- `outline @lid` – cyan, 8 px; `outline @lid #ff3b30 12px 0.5s` – colour (#hex or a name), width, fading in.
- `outline @lid off 1s` fades it out. Works in `parallel` and `each` (`each @blocks stagger 0.2s { outline $ 0.3s }`).
- It shows through parts in front; a hidden part also gets a faint tint of the colour, so you can find buried parts.
- Every view and PNG show it; it follows the cut and blanking. (Not the same as the **Shaded + outline** view, which draws edges.)

# Assembly tree

Right-click a row for its menu; **F2** renames, **Delete** removes, ⌘/Ctrl-click adds or removes a row, **Shift**-click selects every row from the last one clicked.

In the 3D view, **Shift-drag** a box to select parts: dragged left → right (blue, solid) it picks the parts wholly inside; right → left (green, dashed) also the ones it crosses. Parts behind others count; blanked, removed and cut-away parts don't. ⌘/Ctrl + Shift-drag adds to the selection. Then Blank, Remove (Delete), Group…

- **●** show/hide.
- **🔒** lock/unlock. Locked parts can't be animated; CAD starts locked.
- **Rename:** a display name for a part (scripts keep its id). Renaming a group updates the script.
- **Remove from assembly:** takes a part out of this animation only. Restore it from **Removed**.
- **Group…:** makes a group (`@name`) from the selection.
- **Folders:** right-click **Groups** or a folder → **New folder…**; drag groups or folders onto a folder (or use **Move to folder…**). Click a folder to select all its parts; its ● / 🔒 hide or lock them all. Folders only tidy the tree – scripts use the groups.
- **Colour** (info box): base colour of the selection. The swatches are colours already in the model (yours first, then the CAD colours); the picker gives any colour. A second row is a **palette** from a key colour (pick it with **Palette**): complementary, split complementary, triadic and analogous. In the script, `color TARGET ` offers the same colours; click the chip by a `#hex` to change it. **Reset** goes back to the CAD colour.
- **Snapshots** (top bar): named start states (locks, hides, placements, camera). Save also records the camera.

**Tools** (floating bar on the left of the 3D view):
- **Blank / Unblank** (H) the selection; **Blank others** (⇧H); **Show all**.
- **Keep uncut** (K): cuts leave the selection whole.
- **Select by name** (F): every part whose name contains the text.
- **Set origin**: click a cylindrical face (the axis), then a flat face (the height); the model moves so that point is 0,0,0.
- **Move** (✥, W) / **Rotate** (⟳, E): the gizmo's mode for the selection – a part, several parts or a group (the gizmo sits on their centre). At the start (t = 0) it places locked CAD too. Hold **Alt/Option** to rotate in 15° steps; **⌘-drag** (Ctrl-drag on Windows/Linux) drags out a linked copy and leaves the original.
- **Annotate** (✎, or right-click → Annotate… in the tree): a title and a note about the selected parts, group or folder. Click the point its leader should point at (Esc: the centre of what's annotated); type the title and note (Enter or Done saves). Drag a card to move it, double-click to edit, Delete removes it (⌘Z brings it back). The note shows on hover. The point follows the part it's on; a folder annotation covers whatever the folder holds, and renaming the folder or group keeps it attached. **✎ Notes** in the tree's header adds a **Notes column** to the tree (remembered): each part, solid, group or folder shows the note made on it – a checkbox (show / hide that one, saved) and its title (+N when there are more). Click a title to edit it in place (Enter saves; clearing it deletes the note), click an empty cell to add a note for that row, double-click a title to open its card in the view (for the longer note). **✎ Notes** on the view bar (top of the 3D view) switches every annotation off / on in the view – the same switch as **Show notes in the view** in the bar under the tree's header, which also has ⤓ CSV (title, note, target, the parts it covers, its point). An annotation whose part is hidden – blanked, removed or cut away – is hidden too, whatever its checkbox says (its row says *part hidden*). The AI assistant can read them and propose new or changed ones.
- **Remove** (✕) / **Keep only** (◉): take the selected parts out of this animation, or every *other* part (the fewest top-level pieces not holding the selection). Removed parts are listed under **Removed** in the tree with Restore; ⌘Z undoes either in one step. Handy after Shift-drag box selection when trimming an imported model.
- **CAD** (📦): each loaded model has a position (x, y, z m) and a turn about the vertical (°) – edit them to line several models up; changes apply at once and are saved. Once parts are removed, **✂ Slim** writes `CAD/<name>-slim.glb` without them (the original stays) and switches the animation to it: smaller, faster to load, same part ids.
- **Align** (⊟): move the selection so its box lines up with another part's – type the target or **⌖ Pick** it (click it in the view or tree), then per axis min / centre / max, *on* (sits on its far side) or *under*, with a gap; presets Sit on top, Centre on, Under, Beside +x. It sets the start pose (shapes and copies get new numbers, other parts a placement); ⌘Z undoes it.
- **Gizmo snap** (Controls): move step (off, 0.01 … 1 m) and rotate step (off, 1 … 90°, 15° by default).
- **Shape**: add a box, cylinder, tube, sphere, cone, plane or hex prism, with sizes, position, colour and a linear or circular array. Select a shape to edit it. In scripts use its name (`pipe`); array copies are `bolt-0`, `bolt-1`… (`bolt-*`).
- On a short window the tools bar shows icons only (hover a button for its name), two to a row if it's still too tall.
- **Duplicate** (⧉, ⌘D, or right-click in the tree): a *linked copy* of the selected parts, assemblies or group, made in place and selected with the gizmo in Move mode – drag it where it goes (or ⌘-drag the original to copy and move in one go). It shares the source's geometry and follows it (remove a source part and it leaves the copy too). The Copy panel (right-click a copy in the tree → **Edit copy…**; ✕ or Esc closes it) sets its name, what it copies, position (its centre, m), rotation (°), a mirror (x, y or z through its centre) and an array – linear (count, step in m) or circular (count, about a vertical axis through x, z; angle 360 = evenly round). Array members are `pump-1-0`, `pump-1-1`… (`pump-1-*`) in scripts. The gizmo moves it too. Copies are listed under **Copies** in the tree. In scripts use the copy's name (`pump-1`); parts inside it need their full id (`copies/pump-1/…`).
- **Thumbnail**: this moment becomes the card image on Home (a `thumbnail` script step wins).
- **Views**: save the camera as a named view; use it with `camera <name> 2s`.
- **Group** (G): a group (`@name`) from the selection.
- **CAD** (📦): the animation's 3D models. **＋** loads a .glb from the vault's `CAD/` folder; **Upload a .glb from disk…** copies one into the vault and loads it; **✕** removes one from this animation (the file stays). The first model stands centred on the origin; later ones keep their coordinates. A new, empty animation offers **Load a CAD model** in the middle of the view. Part ids start with the model's id (from the file name).

**Undo:** ⌘/Ctrl+Z, redo ⇧⌘Z – colours, moves, lock/hide, groups and folders, keep uncut, shapes, renames, removals. In the script editor, ⌘Z undoes typing.

Select an unlocked part to move it with the gizmo: **W** move, **E** rotate, **R** reset, **Esc** deselect.
At time 0 this sets the start pose; later, it writes the move into the script.

# Script language

One step per line, run in sequence. `#` comments. Durations like `2s` or `500ms`; no duration means instant.

```
move @lid by [0,3,0] 6s ease          # relative; "to [x,y,z]" = absolute
rotate @lid by [0,0,90] 4s about [0,12,0]
pivot @lid [0,12,0]
hide @x 1s
show @x
fade @x to 0.2 2s
blank @x 1s                           # hide; also on locked parts
unblank @x                            # unblank all: everything the script blanked
blank others @core 1s                 # reverse blank: hide everything else
color @lid #2e86de 1s
color @lid reset 1s
outline @lid #ff3b30 12px 0.5s        # a glow around the parts, seen through others
outline @lid off 1s
highlight @spent spent 1s
camera [12,16,14] look [0,5,0] 3s
camera overview 2s                    # a view saved with the Views tool
label "Remove lid" "subtitle"
cutaway quarter
cutaway half -z at @reactor          # side removed (x -x y -y z -z), centred on a point or target
cutaway half nocap                    # cut faces are capped (darker part colour); nocap leaves them open
cutaway half x keep @lid, machine     # …leaving these parts whole
wait 2s
thumbnail outline                     # this moment is the card image on Home
annotate all off                      # annotations: hide all…
annotate @pumps on 1s                 # …fade in those on the pumps (or "Title", an id like a1)
parallel {
  move @lid by [4,0,0] 5s
  fade @bolts to 0 2s
}
```

**Targets:**
- an id, or a short name (`F1-14-3`) when it's unique
- `@group`
- `~text`: every part whose name contains the text (`blank ~V-005202-001 1s`)
- a glob (`F1-*-3`)
- several, comma-separated: `move F1-14-3, F1-16-3 by [0,.25,0] 1s`

# Lists and loops

```
list @layer3 = F1-*-3
each @layer3 stagger 0.2s order ring {
  move $ by [0, 1 + $i*0.05, 0] 1s
  fade $ to 0 0.5s
}
```

- **`$` and `$i`:** `$` is the current item, `$i` its index.
- **Timing:** item *i* starts at *i* × stagger. `stagger 0` runs all items at once; no stagger runs one after another.
- **Order:** `order x|-x|y|-y|z|-z|ring|-ring|random` (default: as listed).

# Editing the script

- **Errors:** underlined; click the error count to jump to it. A fix appears as a button in the script bar: **🔓 Unlock** (all locked parts the script moves), **Restore part**, **Undo delete**.
- **Step times** in the gutter: **click** to run to a step, **drag** to scrub within it, **⌘↵** runs to the cursor's step.
- **🎯 Picking:** type `move ` (or `fade `, `each `, `list @x = `…), then click parts in the tree or 3D view to insert them. ⌘-click adds another; **Esc** stops.
- **📷** inserts the current camera view.

# Illustration

Print-quality vector drawings (SVG) made from the geometry: exact hidden lines, line weights in mm, a layer per line type (outline, crease, hidden, hatch, annotations, border, title box). Views are orthographic.

- **⤓ Export SVG** (Controls) draws the current view with the paper, scale and line settings above it.
- The **drawing script** lists sheets. Lines before the first `sheet` are defaults. **▶ Preview** renders every sheet fast as a PNG (the cursor's sheet first) and shows them – see below. **⤓ Save all** writes every sheet to `Drawings/<animation>/` in the vault as `<file>.svg`, `.pdf` and `.png` (`file` sets the name; default: the sheet name). For batches outside the app: `npm run drawings -- "<animation>"` (with the app running).
- Long jobs (Save all, exact drawings, PDF) show a progress card at the bottom left of the view.

```
paper A1 landscape
scale 1:50
sheet core "Core – half section"
  view front
  at "Lift lid"
  cut half x
  hide @building
```

Sheet commands: `view` (iso, front, back, top, bottom, side, left, right, a saved view or `[dx, dy, dz]`), `snapshot "name"`, `at 12s` or `at "Chapter"`, `cut none|half|quarter [sides] [at [x,y,z]]`, `hide …`, `only …`, `title "…"` (the drawing name, in the title box), `file name` (export file name; default: the sheet name), and the defaults `paper`, `scale`, `hidden on|off`, `crease 30`, `hatch 2.5|off` (section hatching, mm), `fill off|tint|colour` (part colours under the lines), `style shaded|outline|hidden` and `dpi 150` (the fast PNG of the sheet, rendered like the view), `annotate on` (annotation callouts – a leader and the title in a box – for the annotations shown at that sheet's pose; skips ones whose parts the sheet hides). **▶ Preview** renders every sheet fast (the cursor's first), saves `<file>.png` to the vault and shows them: a strip of thumbnails, the chosen one large; ⤓ SVG / ⤓ PDF there make the exact drawing of that sheet. While the preview is open, editing a sheet re-renders it about 0.3 s after you stop typing, and moving the cursor into a sheet shows it. The title box (lower right) shows the title and scale; `titleblock off` leaves it out. Cut faces are capped and hatched. Drawing a sheet leaves the studio's view and pose as they were.

# AI assist

Ask about the model or describe animation steps.
- It looks things up in the tree (including each part's colour, and parts by colour – e.g. everything off-palette), checks its scripts compile, and can take screenshots. It knows the palette (the scene's named colours and the palette swatches) and the colours already used.
- Every change comes as a card you **Accept** or **Reject**: script edits (with **▶ Preview**), groups, lock/hide/colour/remove changes, positions (where parts start – e.g. “stand the machine on the vessel”), shapes (make, change or delete – e.g. “a 6 m tube, 600 mm OD”), linked copies and annotations. It can propose copies and their annotations in one go: the annotations attach once the copies are accepted.
- While a reply is still running its cards have **Accept now** / **Reject**: a change accepted then is applied at once (and isn't applied again when the reply ends). **Stop** keeps the cards made so far.
- If the connection goes quiet (no data for 2 minutes) the reply ends with a message, keeping its cards – send again to retry. If the reply has finished but the panel stops showing it (still "Thinking…" a minute later), the turn is closed for you: your prompt, the reply and its cards stay in the chat.
- Code blocks in replies have **Insert into script**.
- Every send is logged in full (requests, thinking and text, tool calls and results, proposals, what was handed to the panel and when, a heartbeat every 5 s saying what the reply is waiting for, timings, errors) to `Logs/assist/<animation>/<date time>.jsonl` in the vault, and each request through the server's proxy to `Logs/assist/proxy.jsonl` (status, time to first byte, bytes, how it ended) – for debugging slow or stuck replies. The key is never logged.

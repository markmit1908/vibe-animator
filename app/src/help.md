# Refuel Animation

Animations of reactor refuelling over CAD models. Each animation is one file in your vault
(`~/Documents/Refuel animations` by default). The 3D models (.glb) live in the vault's `CAD/` folder and are shared
between animations. Everything you change in an animation saves automatically; the clock icon shows its versions.

# Home

New, Duplicate, Rename, Delete (to the trash), folders and versions for your animations.
- **Import** reads an animation file, or an old project's `.json`.
- **Import old project (.zip)…** reads an old project together with its 3D model.

# The Studio

- **Assembly** (left): the part tree.
- **3D view** (centre): orbit with the mouse, click parts to select them.
- **Controls** (right): play/pause (**Space**), speed, time, cutaway, chapters.
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

# Assembly tree

Right-click a row for its menu; **F2** renames, **Delete** removes, ⌘/Ctrl-click adds or removes a row, **Shift**-click selects every row from the last one clicked.

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
- **Shape**: add a box, cylinder, tube, sphere, cone, plane or hex prism, with sizes, position, colour and a linear or circular array. Select a shape to edit it. In scripts use its name (`pipe`); array copies are `bolt-0`, `bolt-1`… (`bolt-*`).
- **Thumbnail**: this moment becomes the card image on Home (a `thumbnail` script step wins).
- **Views**: save the camera as a named view; use it with `camera <name> 2s`.
- **Group** (G): a group (`@name`) from the selection.

**Undo:** ⌘/Ctrl+Z, redo ⇧⌘Z – colours, moves, lock/hide, groups, renames, removals. In the script editor, ⌘Z undoes typing.

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

# AI assist

Ask about the model or describe animation steps.
- It looks things up in the tree, checks its scripts compile, and can take screenshots.
- Every change comes as a card you **Accept** or **Reject**: script edits (with **▶ Preview**), groups, lock/hide/colour/remove changes, positions (where parts start – e.g. “stand the machine on the vessel”), and shapes (make, change or delete – e.g. “a 6 m tube, 600 mm OD”).
- Code blocks in replies have **Insert into script**.

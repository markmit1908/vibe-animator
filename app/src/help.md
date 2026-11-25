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
- **Shaded / Hidden line:** ⚙ sets the line style.
- **Iso / Front / Top / Side / Fit**
- **⤓ PNG**

# Assembly tree

Right-click a row for its menu; **F2** renames, **Delete** removes, ⌘/Ctrl-click selects several.

- **●** show/hide.
- **🔒** lock/unlock. Locked parts can't be animated; CAD starts locked.
- **Rename:** a display name for a part (scripts keep its id). Renaming a group updates the script.
- **Remove from assembly:** takes a part out of this animation only. Restore it from **Removed**.
- **Group…:** makes a group (`@name`) from the selection.
- **Colour** (info box): base colour of the selection. The swatches are colours already in the model (yours first, then the CAD colours); the picker gives any colour. **Reset** goes back to the CAD colour.
- **Snapshots** (top bar): named start states (locks, hides, placements, camera). Save also records the camera.

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
color @lid #2e86de 1s
color @lid reset 1s
highlight @spent spent 1s
camera [12,16,14] look [0,5,0] 3s
label "Remove lid" "subtitle"
cutaway quarter
wait 2s
parallel {
  move @lid by [4,0,0] 5s
  fade @bolts to 0 2s
}
```

**Targets:**
- an id, or a short name (`F1-14-3`) when it's unique
- `@group`
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

- **Errors:** underlined. Hover for quick-fixes (**Unlock**, **Restore part**, **Undo delete**).
- **Step times** in the gutter: **click** to run to a step, **drag** to scrub within it, **⌘↵** runs to the cursor's step.
- **🎯 Picking:** type `move ` (or `fade `, `each `, `list @x = `…), then click parts in the tree or 3D view to insert them. ⌘-click adds another; **Esc** stops.
- **📷** inserts the current camera view.

# AI assist

Ask about the model or describe animation steps.
- It looks things up in the tree, checks its scripts compile, and can take screenshots.
- Every change comes as a card you **Accept** or **Reject**: script edits (with **▶ Preview**), groups, and lock/hide/colour/remove changes.
- Code blocks in replies have **Insert into script**.

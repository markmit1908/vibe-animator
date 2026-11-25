# TODO

## Model and scene
- [ ] Real dimensions for the placeholder reactor (all dimensions are placeholders)
- [ ] Section caps on clipped shells (cutaway)
- [ ] 3D callout labels
- [ ] Outlines for imported CAD (inverted hulls are only on the generated model)
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls on the plant model)

## Basic geometry modelling
- [ ] Add simple primitives in the studio (box, cylinder, sphere, cone, plane, hex prism), sized and placed by
      numbers or the gizmo; saved in the animation (`scene.shapes`), shown in the tree, scriptable by id like CAD parts
- [ ] Edit a shape's dimensions, colour and name after creating it; duplicate and delete it
- [ ] Simple combinations: group shapes into an assembly, and linear / circular arrays (e.g. bolt circles)
- [ ] Optional later: extrude a 2D sketch, boolean cut (for markers, tools and stand-ins for missing CAD)

## Output
- [ ] Video export (frame-by-frame render of the timeline)
- [ ] PNG export: option for a solid background / chosen size

## Script and studio
- [ ] Camera views: also store the field of view and offer an ease per `camera` step
- [ ] Undo: cover snapshot Save-as / delete and the palette key
- [ ] Tools bar: more utility tools (isolate, show all, select by group, measure)
- [ ] Untested: the Undo delete quick-fix click; a script `list` name clashing with a tree group

## AI assist
- [ ] Try a live chat after the switch to SolverKit's AssistPanel (tests use injected proposals, no API calls)
- [ ] Teach the assistant camera views and the palette (context lists views; prompt mentions `camera <view>`)

## SolverKit (propose in the SolverKit repo; see app/docs/SOLVERKIT.md)
- [ ] Home: app importers can't claim a `.zip`
- [ ] Home: "New model" ignores `manifest.noun`
- [ ] create-solver template: modules without `runs` still call it
- [ ] AssistPanel: styles for `.assist-reply` Markdown (now in app/src/index.css)
- [ ] AssistPanel: slots for a header (effort, status) and code-block actions ("Insert into script")

## Housekeeping
- [ ] Push to a remote
- [ ] Delete the merged `solverkit-migration` branch

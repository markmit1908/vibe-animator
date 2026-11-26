# TODO

## Model and scene
- [ ] Real dimensions for the placeholder reactor (all dimensions are placeholders)
- [ ] Section caps: optional hatching; a 5×5 vote if isolated specks remain on caps
- [ ] 3D callout labels
- [ ] Outlines for imported CAD (inverted hulls are only on the generated model)
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls on the plant model)

## Basic geometry modelling
- [ ] Add simple primitives in the studio (box, cylinder, sphere, cone, plane, hex prism), sized and placed by
      numbers or the gizmo; saved in the animation (`scene.shapes`), shown in the tree, scriptable by id like CAD parts
- [ ] Edit a shape's dimensions, colour and name after creating it; duplicate and delete it
- [ ] Simple combinations: group shapes into an assembly, and linear / circular arrays (e.g. bolt circles)
- [ ] Optional later: extrude a 2D sketch, boolean cut (for markers, tools and stand-ins for missing CAD)

## Origin
- [ ] Set origin: cylinders with a non-vertical axis; also shift absolute script coordinates (offer to)

## Output
- [ ] Hidden line: dashed hidden edges (selected parts), section hatching, SVG (vector) export
- [ ] Video export (frame-by-frame render of the timeline)
- [ ] PNG export: option for a solid background / chosen size

## Script and studio
- [ ] Camera views: also store the field of view and offer an ease per `camera` step
- [ ] Undo: cover snapshot Save-as / delete and the palette key
- [ ] Tools bar: more utility tools (isolate, select by group, measure)
- [ ] Untested: the Undo delete quick-fix click; a script `list` name clashing with a tree group

## AI assist
- [ ] Try a live chat after the switch to SolverKit's AssistPanel (tests use injected proposals, no API calls)
- [ ] Teach the assistant the palette and the thumbnail keyframe
- [ ] Optional faster model (e.g. Sonnet) for routine edits, chosen in the Assist header

## SolverKit (propose in the SolverKit repo; see app/docs/SOLVERKIT.md)
- [ ] Home: app importers can't claim a `.zip`
- [ ] Home: "New model" ignores `manifest.noun`
- [ ] create-solver template: modules without `runs` still call it
- [ ] AssistPanel: styles for `.assist-reply` Markdown (now in app/src/index.css)
- [ ] AssistPanel: slots for a header (effort, status) and code-block actions ("Insert into script")
- [ ] Card thumbnails for non-React views: a documented `putThumb` path (we call the store directly)

## Housekeeping
- [ ] Delete the merged `solverkit-migration` branch

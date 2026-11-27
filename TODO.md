# TODO

## Model and scene
- [ ] Real dimensions for the placeholder reactor (all dimensions are placeholders)
- [ ] Section caps: optional hatching; a 5×5 vote if isolated specks remain on caps
- [ ] 3D callout labels
- [ ] Outlines for imported CAD (inverted hulls are only on the generated model)
- [ ] Batch locked repeated parts into InstancedMesh at runtime (fewer draw calls on the plant model)

## Basic geometry modelling
- [x] Primitives (box, cylinder, tube, sphere, cone, plane, hex prism), edit, duplicate, delete, linear / circular arrays
- [ ] Extrude a 2D sketch, boolean cut (for markers, tools and stand-ins for missing CAD)
- [ ] Shapes: array along a path; snapping to CAD faces

## Origin
- [ ] Set origin: cylinders with a non-vertical axis; also shift absolute script coordinates (offer to)

## Output
- [ ] Outlines: pulse; saved always-on outlines; the selection as an outline; more than 4 looks at once (they share by colour now)
- [ ] Hidden line: dashed hidden edges (selected parts), section hatching, SVG (vector) export
- [ ] Print-quality SVG line drawings (in progress on `feature/svg-drawings`: phases 1–3 done – exact HLR, ISO layers, the `.draw` sheet script with preview and Save all, section caps + hatching, title block, fills; next: headless batch CLI, PDF): today's outlines are fine for animation but not for print, especially large-format drawings. Vector SVG of silhouettes, creases and part boundaries (from the geometry, not the screen pixels), with hidden lines removed, clean joins, line weights in mm at a chosen paper size and scale, layers per line type, and no limit from screen resolution
- [ ] Better transparency: making a part see-through to show what's inside is messy today, with every surface stacking up. Needs a clearer model: only the outer shell drawn see-through (depth pre-pass / first surface only), sorting or order-independent transparency, optional ghosted edges-only or x-ray styles, and contents drawn solid behind it
- [ ] Video export (frame-by-frame render of the timeline)
- [ ] PNG export: option for a solid background / chosen size

## Script and studio
- [ ] Camera views: also store the field of view and offer an ease per `camera` step
- [ ] Undo: cover snapshot Save-as / delete and the palette key
- [ ] Tools bar: more utility tools (isolate, select by group, measure)
- [ ] Group folders: drag a part onto a group row to add it; folder colours/locks as their own setting (now they apply to the groups' parts)
- [ ] Untested: the Undo delete quick-fix click; a script `list` name clashing with a tree group

## AI assist
- [ ] Try a live chat after the switch to SolverKit's AssistPanel (tests use injected proposals, no API calls)
- [ ] Teach the assistant the palette and the thumbnail keyframe
- [ ] Shapes from the assistant: let a script proposal reference shapes proposed in the same turn (today: shape first, script after it's accepted)
- [ ] Optional faster model (e.g. Sonnet) for routine edits, chosen in the Assist header

## SolverKit (propose in the SolverKit repo; see app/docs/SOLVERKIT.md)
- [ ] Vault.files: resolve the root (and walked paths) – listing a vault reached through a symlink (macOS /var → /private/var) raises ValueError; the app resolves its vault path meanwhile
- [ ] Home: app importers can't claim a `.zip`
- [ ] Home: "New model" ignores `manifest.noun`
- [ ] create-solver template: modules without `runs` still call it
- [ ] AssistPanel: styles for `.assist-reply` Markdown (now in app/src/index.css)
- [ ] AssistPanel: slots for a header (effort, status) and code-block actions ("Insert into script")
- [ ] Card thumbnails for non-React views: a documented `putThumb` path (we call the store directly)

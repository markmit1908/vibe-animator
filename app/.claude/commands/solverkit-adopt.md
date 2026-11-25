---
description: Move an app that adopted SolverKit before standard modules onto them
argument-hint: "[ids to limit to, optional]"
---

# Adopt SolverKit's standard modules (an app already on SolverKit)

For an app that already uses SolverKit packages but wires features by hand (built before modules). Optional limit: `$ARGUMENTS`.

**SolverKit** is `../vibe-solverkit` unless this app's CLAUDE.md says otherwise. Read there: `prompts/modules/README.md` (catalog, detection, recipes), `docs/ADOPTING.md` (latest versions) and `docs/PLAN.md` "Standard modules". Never edit SolverKit from here.

## 1. Survey (no changes)
1. Read this app's CLAUDE.md, README and git status. Note any uncommitted work: you must not touch, stage or revert it.
2. Run the status steps of `/solverkit-modules` (or follow them from its file): versions pinned vs latest, and every catalog id as module / own / none, with `file:line`.
3. For each **own** feature with a ✅ module, check its behaviour against the module's options: ids, labels, order, view ids, toasts, context fields, help topics. List any mismatch as a gap.
4. Map the app's side (README "The app's side", A1–A11 and table B), including how `npm run dev` works today (A11: its own script, `concurrently`, `make dev`): where each interface is implemented, and anything in table C the app still has its own copy of (a deletion candidate).
5. Read the CHANGELOGs between the pinned and latest versions; list the code changes the upgrade needs.

## 2. Confirm
Present:
- the upgrade (package → version)
- per feature: **switch** (with the options to pass), **keep** (gap stated), or **not yet a module**
- **the app's side**: A1–A11 with `file:line`; for `npm run dev`, the `solverkit.dev.json` that would replace its own script (same ports and commands); for each switch or addition, the table-B items the app already has and those it must still write (interface, type, file)
- features the app doesn't have that a ✅ module offers. Offer them, but don't add any unless the user picks them (adopting doesn't add features).

Ask with AskUserQuestion (multi-select of the switches, and of optional additions). Do nothing until the user answers.

## 3. Apply, in this order, one commit each where the app's rules allow
1. The upgrade alone, with its required code changes. Full checks pass.
2. The switches, one module at a time per the README recipes; delete the replaced code. Server: move `include_router` lines for report/assist/home/jobs into `PlatformApp` fields.
3. The chosen additions.
4. `npm run dev` on `@solverkit/dev`, if chosen: the config from its current dev script (README `dev` recipe), the Vite `/api` proxy, then delete the old script (and `concurrently` if nothing else uses it). Check it by hand: page loads, `/api` answers through Vite, Ctrl+C stops everything.
Stage only your files.

## 4. Prove and report
Full checks per the app's CLAUDE.md (type check, unit, server, e2e, visual baselines). Report: the before/after status tables, lines removed, what was kept and why (each gap phrased as a SolverKit change for the TODO), test counts, commit hashes.

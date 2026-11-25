---
description: Show which SolverKit standard modules this app has, and add or remove them
argument-hint: "[status | add <ids…> | remove <ids…>]"
---

# SolverKit modules: status, add, remove

Arguments: `$ARGUMENTS` (empty means `status`).

**SolverKit** is the sibling checkout `../vibe-solverkit` unless this app's CLAUDE.md says otherwise. If it's missing, stop and ask where it is. Read `prompts/modules/README.md` there first: its catalog (ids, status, minimum versions), detection table and install/remove recipes are the source of truth. Never edit SolverKit from this session.

## 1. Status (always)

1. Read this app's CLAUDE.md. Find the frontend (`frontend/src` or similar) and the server file that calls `create_app`.
2. Record the pinned versions: `@solverkit/*` in the frontend's package.json, and the `solverkit-*.whl` pin. Compare with the latest in SolverKit's `docs/ADOPTING.md`.
3. For every catalog id, decide **module**, **own** or **none** with the detection table. Grep, then open the file to confirm. Note where each lives (`file:line`).
4. Report one table:

   | Id | Module | State | Where | Catalog status | Needs version |
   |---|---|---|---|---|---|

   Then, separately:
   - **can switch:** `own` features whose module is ✅ (and whether the pinned version is new enough)
   - **can add:** `none` features whose module is ✅
   - **not yet modules:** ⏳ or 🟡 rows (kept as the app's own code)

5. **The app's side** (README "The app's side"): for A1–A11 (A11: does `npm run dev` go through `solverkit-dev`?), where the app implements each (`file:line`) or "missing"; and for every installed or requested module, its row in table B with each item marked ✅ present or ✗ to write.

If the argument was `status` (or empty), stop here.

## 2. Confirm (before any change)

For `add` or `remove`, list exactly what will change and ask the user to confirm with AskUserQuestion (multi-select of the requested ids, plus "upgrade SolverKit first" when a module needs a newer version):
- each id: install from scratch, switch from own code, or remove
- **what the app must develop** for each: its table-B items still ✗, with the exact interface (type and file) and where it will go in this app
- the files to be edited, and the model fields involved (`tables`, `drawings`, `report`: data in model files is never deleted)
- ⏳ ids requested: say they aren't available yet and drop them
- unknown ids: list the catalog's ids and drop them

Do nothing until the user confirms.

## 3. Apply

- **Upgrade first** if needed: copy the new tarballs/wheel into `vendor/solverkit/`, remove the old ones, install with exact versions, read the CHANGELOGs between the versions and apply any required changes. Build tarballs with SolverKit's `scripts/vendor.sh <this app> <pkgs…>` and `scripts/vendor-py.sh <this app> <extras>` when no ready-built ones are given.
- **Add / switch:** follow the module's recipe in the README. When switching, keep ids, labels, order, views and toasts the same and delete the replaced code. If a module can't reproduce the app's behaviour, keep the app's code, mark it `// solverkit-candidate: <gap>` and report the gap.
- **Remove:** delete the `defineModule(…)` line or the `PlatformApp` field and the code only it used. Keep model data.
- Update the app's CLAUDE.md "SolverKit" section with the module list, if it has one.

## 4. Prove and commit

Run the app's full checks as its CLAUDE.md says (type check, unit tests, server tests, e2e; visual baselines where it has them). Rerun a known-flaky test once before calling it a failure. Stage only the files you changed (other sessions may have work in the tree). Commit per the app's rules; don't push.

Report: the new status table, what changed (lines added/removed), anything kept and why, test counts, the commit hash, and gaps to raise as SolverKit changes.

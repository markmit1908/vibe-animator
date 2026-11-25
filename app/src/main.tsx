// RefuelAnim on SolverKit: the manifest and the boot. Home, the editor, Settings and every view come from SolverKit;
// the store is in src/run.ts, the views are standard modules (src/module.tsx).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import { Clapperboard as Icon } from "lucide-react";
import { ModelEditor, SolverApp, configureApp } from "@solverkit/app";
import { blankModel, services, store } from "./run";
import type { Model } from "./run";
import { downloadModel } from "./module";
import { readImport } from "./importOld";   // registers the modules
import schema from "./model.schema.json";
import helpText from "./help.md?raw";
import "./index.css";
import type { DesktopBridge } from "@solverkit/app";

// The desktop shell's bridge (pywebview, desktop/main.py); the browser otherwise. solverkit-candidate (as DemoSolver's).
interface PyApi { open_url(u: string): void; pick_folder(): Promise<string | null>; show_folder(p: string): void }
const py = (): PyApi | undefined => (window as unknown as { pywebview?: { api?: PyApi } }).pywebview?.api;
const desktop: DesktopBridge = {
  available: () => !!py(),
  onReady: (go) => { if (py()) go(); else window.addEventListener("pywebviewready", () => go(), { once: true }); },
  openUrl: (u) => { const a = py(); if (a) a.open_url(u); else window.open(u, "_blank", "noopener"); },
  pickFolder: async () => (py() ? py()!.pick_folder() : null),
  showFolder: (p) => py()?.show_folder(p),
};

configureApp({
  schema,
  manifest: { name: "Refuel Animation", tagline: "Animations of reactor refuelling over CAD models.", storagePrefix: "refuelanim",
              envPrefix: "REFUELANIM", icon: Icon, noun: { one: "animation", many: "animations" } },
  services,
  store,
  home: {
    newModel: () => ({ name: "Untitled", problem: blankModel("Untitled") }),
    importAccept: ".json,application/json,.zip,application/zip",
    importers: [{
      // an animation model file, or the old app's project (.json, or .zip with its 3D model)
      match: (f) => /\.(json|zip)$/i.test(f.name),
      run: async (f, c) => {
        const m = await readImport(f);
        return { open: (await store.createProject({ folder: c.folder, name: m.name ?? f.name, problem: m, on_conflict: c.onConflict })).id };
      },
    }],
    download: (m) => downloadModel(m as Model),
  },
  help: { markdown: async () => helpText },
  markdown: (md) => marked.parse(md, { async: false }),
  desktop,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolverApp editor={(m) => (
      <ModelEditor<Model, never> key={m.id} id={m.id} initial={m.model as Model} store={store} themeKey="refuelanim-theme" />
    )} />
  </StrictMode>,
);

// "Import old project (.zip)" on Home. solverkit-candidate: SolverKit's Home sends every .zip to its own archive
// import before the app's importers see it; with an "app importers may claim a .zip first" change this goes away
// and the importer in main.tsx handles old zips through the normal Import button.
import { useRef, useState } from "react";
import { store } from "./run";
import { readImport } from "./importOld";

export function OldImportSection() {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (f: File) => {
    setBusy(true); setError(null);
    try {
      const m = await readImport(f);
      const meta = await store.createProject({ name: m.name ?? f.name.replace(/\.zip$/i, ""), problem: m, on_conflict: "copy" });
      location.hash = `#/p/${meta.id}/studio`;
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground px-1 py-2">
      <button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy}
        onClick={() => input.current?.click()} title="A .zip exported by the old app (project.json + its 3D model)">
        {busy ? "Importing…" : "Import old project (.zip)…"}
      </button>
      {error && <span className="text-destructive">{error}</span>}
      <input ref={input} type="file" accept=".zip,application/zip" className="hidden" aria-label="Import an old project zip"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void go(f); }} />
    </div>
  );
}

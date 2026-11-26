// The Studio view: the animation studio (3D view, assembly tree, script, assist) from the repo's ../src/studio,
// mounted into this full-bleed view. Edits go through ctx.edit (autosaved, versioned by SolverKit).
// Changes from elsewhere (a version restored, Replace from file, the file edited on disk) remount the studio.
import { useEffect, useRef, useState } from "react";
import { mountStudio } from "../../src/studio/studio";
import { joinLines } from "../../src/model/file";
import type { Context } from "./module";
import { mountAssist } from "./assist";
import { store } from "./run";
import type { Model } from "./run";

const fileUrl = (path: string) => `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;
/** Stable JSON: sorted keys, empty objects/arrays and undefined dropped (a save may come back reordered or trimmed). */
const stable = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = stable((v as Record<string, unknown>)[k]);
      if (x === undefined || (typeof x === "object" && x !== null && Object.keys(x).length === 0)) continue;
      out[k] = x;
    }
    return out;
  }
  return v;
};
/** What the studio shows (chat and view state left out: they don't need a remount), normalised. */
const content = (m: Partial<Model>) =>
  JSON.stringify(stable([joinLines(m.script?.text).replace(/\s+$/, ""), m.snapshots, m.groups, m.scene]));

export function StudioView({ c }: { c: Context }) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef(c);
  ctx.current = c;
  const mine = useRef(content(c.model));   // the content as the studio last saw or wrote it
  const [generation, setGeneration] = useState(0);

  // an outside change: remount with the new model
  useEffect(() => {
    if (content(c.model) !== mine.current) { mine.current = content(c.model); setGeneration((g) => g + 1); }
  }, [c.model]);

  // mounts run one after another: a studio still loading when its effect is cleaned up (React StrictMode mounts
  // twice; a remount after an outside change) must not tear down its successor, which shares the container
  const chain = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let studio: { dispose(): void } | undefined, gone = false;
    chain.current = chain.current.then(async () => {
      if (gone) return;
      const model = ctx.current.current();
      mine.current = content(model);
      const s = await mountStudio(host.current!, model, {
        edit: (patch) => {
          mine.current = content({ ...ctx.current.current(), ...(patch as Partial<Model>) });
          ctx.current.edit(patch as Partial<Model>);
        },
        fileUrl,
        assist: { base: "/api/assist/proxy", status: "/api/assist" },
        mountAssist,
        putThumb: (svg: string) => store.putThumb(ctx.current.id, svg),
      });
      if (gone) s.dispose(); else studio = s;
    }).catch((e) => console.error("studio:", e));
    return () => { gone = true; studio?.dispose(); studio = undefined; };
  }, [c.id, generation]);
  // fill the editor area (not the page): positioned, so the studio's panels stay inside it
  return <div ref={host} style={{ position: "relative", width: "100%", height: "100%", minHeight: 0, overflow: "hidden" }} />;
}

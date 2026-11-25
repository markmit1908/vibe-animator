// The Studio view: the animation studio (3D view, assembly tree, script, assist) from the repo's ../src/studio,
// mounted into this full-bleed view. Edits go through ctx.edit (autosaved, versioned by SolverKit).
import { useEffect, useRef } from "react";
import { mountStudio } from "../../src/studio/studio";
import type { Context } from "./module";

const fileUrl = (path: string) => `/api/files/${path.split("/").map(encodeURIComponent).join("/")}`;

export function StudioView({ c }: { c: Context }) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef(c);
  ctx.current = c;
  useEffect(() => {
    let studio: { dispose(): void } | undefined, gone = false;
    mountStudio(host.current!, c.current(), {
      edit: (patch) => ctx.current.edit(patch as Partial<Parameters<Context["edit"]>[0] & object>),
      fileUrl,
      assist: { base: "/api/assist/proxy", status: "/api/assist" },
    }).then((s) => { if (gone) s.dispose(); else studio = s; }, (e) => console.error("studio:", e));
    return () => { gone = true; studio?.dispose(); };
    // one studio per opened animation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);
  return <div ref={host} style={{ position: "absolute", inset: 0 }} />;
}

// Import of the old app's project files ("refuel-project" .json, or .zip with project.json + cad/*.glb):
// converted to an animation model; a zip's .glb files go into the vault's CAD/ folder (PUT /api/files/CAD/<name>).
import { parse as parseYaml } from "yaml";
import { SOLVER, FORMAT, readModel } from "../../src/model/file";
import type { AnimModel, CadRef } from "../../src/model/file";

/** Files in a zip (deflate or stored), read with the browser's DecompressionStream. */
async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const b = new Uint8Array(buf), v = new DataView(buf);
  let e = b.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nlen = v.getUint16(p + 28, true);
    const xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
    const ds = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
    const raw = b.subarray(ds, ds + csize);
    out.set(name, method === 8
      ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer())
      : raw.slice());
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** An old project (or an animation model file) as an animation model. */
export function fromOldProject(p: any): Partial<AnimModel> {
  if (p?.solver) return readModel(p);                          // already a model file
  if (p?.format !== "refuel-project") throw new Error("Not a refuel animation or project file");
  const core = typeof p.core === "string" ? parseYaml(p.core) ?? {} : {};
  const { script: _s, cad_models, ...scene } = core;
  const cad: CadRef[] = (cad_models ?? []).map((m: any) => ({ ...m, file: `CAD/${String(m.file).split("/").pop()}` }));
  return {
    name: p.script?.name?.replace(/\.anim$/, ""),
    solver: SOLVER, format: FORMAT,
    description: `Imported from a project exported ${p.exportedAt ?? ""}.`.trim(),
    scene: { ...scene, cad_models: cad },
    script: { language: "anim", text: p.script?.text ?? "" },
    snapshots: { active: p.snapshots?.active ?? "default", items: p.snapshots?.snapshots ?? {} },
    groups: p.snapshots?.groups ?? {},
    view: p.view,
    chat: p.chat ?? [],
  };
}

/** Read a dropped .json/.zip: the model, after uploading any CAD it carries into the vault. */
export async function readImport(f: File): Promise<Partial<AnimModel>> {
  if (!/\.zip$/i.test(f.name)) return fromOldProject(JSON.parse(await f.text()));
  const files = await unzip(await f.arrayBuffer());
  const pj = files.get("project.json");
  if (!pj) throw new Error("project.json missing from the zip");
  for (const [name, data] of files) {
    const m = name.match(/^cad\/([\w.-]+\.glb)$/);
    if (!m) continue;
    const r = await fetch(`/api/files/CAD/${encodeURIComponent(m[1])}?overwrite=true`, { method: "PUT", body: new Blob([data as BlobPart]) });
    if (!r.ok) throw new Error(`Could not store ${m[1]} in the vault: ${r.statusText}`);
  }
  return fromOldProject(JSON.parse(new TextDecoder().decode(pj)));
}

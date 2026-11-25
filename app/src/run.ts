// RefuelAnim's model type and its store: the server's vault through /api. No engine run: animations play in the browser.
import { serverServices, serverStore } from "@solverkit/engine";
import type { ModelMeta, ModelPlacement } from "@solverkit/engine";
import type { CreateModel } from "@solverkit/app";
import type { ThumbnailPick } from "@solverkit/ui";
import type { AnimModel } from "../../src/model/file";
import { newModel } from "../../src/model/file";

/** A model file: the document the vault holds (src/model/file.ts). */
export type Model = AnimModel & { name: string; uuid: string; description?: string; thumbnail?: ThumbnailPick | null };
export type Meta = ModelMeta & ModelPlacement;

export const blankModel = (name: string): Partial<Model> => newModel(name, []) as Partial<Model>;

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? r.statusText);
  return r.json() as Promise<T>;
};

export const store = { ...serverStore<Model, Meta, unknown, "description">({ zipName: "Refuel animations.zip" }),
                       createProject: (body: CreateModel) => call<Meta>("POST", "/api/projects", body) };
export const services = { ...serverServices(), system: () => call<never>("GET", "/api/system"),
                          importFolder: (path: string) => store.importFolder(path), thumbUrl: (id: string, edited: string) => store.thumbUrl(id, edited) };

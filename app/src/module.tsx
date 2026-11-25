// RefuelAnim's app module: the SolverKit standard modules it uses, and its own views (3D, script; added in M2–M4).
import { defineModule, saveModelFile, modelFileModule, helpModule, assistModule } from "@solverkit/app";
import { Clapperboard } from "lucide-react";
import { StudioView } from "./studio";
import type { EditorContext } from "@solverkit/app";
import type { Model } from "./run";
import { canonical, readModel } from "../../src/model/file";
import { ASSIST_SYSTEM } from "../../src/assist/system";

export type Context = EditorContext<Model, never>;

export const downloadModel = (m: Model) => saveModelFile(canonical(m), m.name);

/** A model file read back: checked to be a refuel animation. */
export function parseModelFile(text: string): Partial<Model> {
  return readModel(text) as Partial<Model>;
}

defineModule(modelFileModule<Model>({ parse: parseModelFile, replaced: "Animation replaced from the file" }));
defineModule(helpModule());
defineModule(assistModule({ system: ASSIST_SYSTEM }));

// The studio: 3D view, assembly tree, script editor and the animation assistant, edge to edge.
defineModule({ name: "studio", views: [{ id: "studio", label: "Studio", icon: Clapperboard, order: 0, fill: true, render: (c: Context) => <StudioView c={c} /> }] });

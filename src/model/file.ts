/**
 * The animation model file (SolverKit model-file envelope; specs/vault.md in SolverKit).
 * One animation = one human-readable JSON file in the vault. 3D data (.glb) is referenced by vault path.
 *
 *   {
 *     "name": "Lid removal", "uuid": "…", "solver": "refuel-anim", "format": 1,
 *     "description": ["…"],
 *     "scene":     { …the former scenes/core.yaml…, "cad_models": [{ "id": "plant", "file": "CAD/plant.glb", … }] },
 *     "script":    { "language": "anim", "text": ["label \"Plant overview\"", "wait 2s"] },
 *     "snapshots": { "active": "default", "items": { "default": { locked, hidden, camera?, placements? } } },
 *     "groups":    { "lid-set": ["plant/…/V-…", …] },
 *     "view":      { "camera": { "pos": [..], "look": [..] }, "time": 0, "mode": "shaded" },
 *     "chat":      [ …assist conversation… ]
 *   }
 */
import type { ShapeDef } from '../scene/shapes';
import type { Snapshot } from '../scene/state';

export const SOLVER = 'refuel-anim';
export const FORMAT = 1;

export type Lines = string | string[];

export interface CadRef {
  id: string;
  /** Vault-relative path of the .glb, e.g. "CAD/plant.glb" (shared between animations). */
  file: string;
  up?: 'z' | 'x' | '-x' | 'y' | '-y';
  ground?: boolean;
  position?: number[];
  rotation_deg?: number[];
  scale?: number;
  clip?: boolean;
}

export interface AnimModel {
  name?: string;
  uuid?: string;
  solver: typeof SOLVER;
  format: number;
  description?: Lines;
  /** Scene setup: the generated placeholder reactor (`generated`, `core`, `vessel`, …), palette, CAD models. */
  scene: Record<string, unknown> & { generated?: boolean; cad_models?: CadRef[] };
  script: { language: 'anim'; text: Lines };
  snapshots: { active: string; items: Record<string, Snapshot> };
  groups: Record<string, string[]>;
  /** Tree folders for groups: folder path ("a/b") → group names (display only). */
  folders?: Record<string, string[]>;
  /** Base colours: part id or "@group" → "#rrggbb" (a part's own colour wins over its group's). */
  colors?: Record<string, string>;
  /** Parts removed from this animation's assembly (the CAD file is untouched). */
  removed?: string[];
  /** Display names for parts (ids, used by scripts, are unchanged). */
  labels?: Record<string, string>;
  /** Named camera views (script: `camera <name> 2s`). */
  views?: Record<string, { pos: number[]; look: number[] }>;
  /** Shapes made in the studio (basic modelling): parts `shapes/<id>`. */
  shapes?: ShapeDef[];
  /** The moment shown as the card image on Home (a script `thumbnail` step wins). */
  keyframe?: { t: number; camera?: { pos: number[]; look: number[] }; mode?: 'shaded' | 'outline' | 'hidden' };
  view?: { camera?: { pos: number[]; look: number[] }; time?: number; mode?: 'shaded' | 'hidden' | 'outline'; paletteKey?: string };
  chat?: unknown[];
  /** Unknown keys are preserved on save (SolverKit rule). */
  [k: string]: unknown;
}

export const joinLines = (l: Lines | undefined) => (Array.isArray(l) ? l.join('\n') : l ?? '');
/** Multi-line text is written as an array of lines (one-line edit = one-line diff). */
export const splitLines = (s: string): string[] => s.replace(/\n$/, '').split('\n');

/** Key order for writing (stable diffs); unknown keys follow in their own order. */
const ORDER = ['name', 'uuid', 'solver', 'format', 'description', 'scene', 'script', 'snapshots', 'groups', 'folders', 'colors', 'removed', 'labels', 'views', 'keyframe', 'shapes', 'view', 'chat'];

export function canonical(m: AnimModel): string {
  const out: Record<string, unknown> = {};
  for (const k of ORDER) if (m[k] !== undefined) out[k] = m[k];
  for (const k of Object.keys(m)) if (!(k in out) && m[k] !== undefined) out[k] = m[k];
  if (typeof out.description === 'string') out.description = splitLines(out.description as string);
  const s = out.script as AnimModel['script'];
  if (s && typeof s.text === 'string') out.script = { ...s, text: splitLines(s.text) };
  return JSON.stringify(out, null, 2) + '\n';
}

/** Read a model file (accepts both string and line-array text). Throws on files that aren't ours. */
export function readModel(json: string | object): AnimModel {
  const m = (typeof json === 'string' ? JSON.parse(json) : json) as AnimModel;
  if (m.solver && m.solver !== SOLVER) throw new Error(`This file belongs to "${m.solver}", not ${SOLVER}.`);
  if ((m.format ?? 1) > FORMAT) throw new Error(`Model format ${m.format} is newer than this app understands (${FORMAT}).`);
  return {
    ...m,
    solver: SOLVER,
    format: m.format ?? 1,
    scene: m.scene ?? {},
    script: { language: 'anim', text: joinLines(m.script?.text) },
    snapshots: m.snapshots ?? { active: 'default', items: { default: { locked: {}, hidden: {} } } },
    groups: m.groups ?? {},
  };
}

/** A new, empty animation over the given CAD models. */
export function newModel(name: string, cad: CadRef[] = []): AnimModel {
  return {
    name, solver: SOLVER, format: FORMAT,
    scene: { generated: false, cad_models: cad },
    script: { language: 'anim', text: `# ${name}\nlabel "${name}"\nwait 2s\n` },
    snapshots: { active: 'default', items: { default: { locked: {}, hidden: {} } } },
    groups: {},
  };
}

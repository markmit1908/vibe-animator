import type * as THREE from 'three';

/**
 * Working part state + named snapshots (scenes/snapshots.yaml, via the dev server).
 *
 *  locked  – never moves: skipped by per-frame matrix updates, not scriptable, no gizmo.
 *            CAD defaults to locked, the generated model to unlocked.
 *  hidden  – not drawn. Hidden + locked CAD parts are *suppressed* (geometry freed).
 *  flags are stored where set explicitly; descendants inherit from the nearest flagged ancestor.
 *
 * A snapshot = flags + camera view + part placements (moves made with the gizmo).
 * Nothing is written until Save; `dirty` tracks unsaved changes.
 */
export interface PartState {
  locked: Record<string, boolean>;
  hidden: Record<string, boolean>;
}
export interface Placement { p: number[]; q: number[] }
export interface Snapshot extends PartState {
  camera?: { pos: number[]; look: number[] };
  placements?: Record<string, Placement>;
}
/** groups: user-defined assemblies (name -> member ids), shared by all snapshots, scriptable as "@name". */
export interface SnapshotFile { active: string; snapshots: Record<string, Snapshot>; groups: Record<string, string[]> }

/** The working state (what the viewer currently shows). */
export const state: PartState & { placements: Record<string, Placement> } = { locked: {}, hidden: {}, placements: {} };
export const store: SnapshotFile = { active: 'default', snapshots: {}, groups: {} };

let dirty = false;
const listeners = new Set<() => void>();
export const isDirty = () => dirty;
export const onDirtyChange = (f: () => void) => listeners.add(f);
export function markDirty(v = true) { dirty = v; listeners.forEach((f) => f()); }

let writer: ((s: SnapshotFile) => Promise<void> | void) | undefined;
/** Where Save writes (the model file, through the studio's io.edit). */
export function setStoreWriter(w: (s: SnapshotFile) => Promise<void> | void) { writer = w; }

export async function writeStore() {
  await writer?.(store);
}

/** Replace the store (SolverKit: from the model file) – the working state follows the active snapshot. */
export function setStore(s: SnapshotFile) {
  store.active = s.active; store.snapshots = s.snapshots; store.groups = s.groups ?? {};
  if (!store.snapshots[store.active]) store.snapshots[store.active] = { locked: {}, hidden: {} };
}

/** Copy the working state (+ camera) into a snapshot. */
export function captureSnapshot(camera: Snapshot['camera']): Snapshot {
  return {
    locked: { ...state.locked },
    hidden: { ...state.hidden },
    camera,
    placements: JSON.parse(JSON.stringify(state.placements)),
  };
}

/** Load a snapshot's flags + placements into the working state. */
export function useSnapshot(s: Snapshot) {
  state.locked = { ...(s.locked ?? {}) };
  state.hidden = { ...(s.hidden ?? {}) };
  state.placements = JSON.parse(JSON.stringify(s.placements ?? {}));
}

/** Registry id of an object, if it has one (set by build/cad registration). */
const idOf = (o: THREE.Object3D) => (o.userData.id ?? o.name) as string | undefined;

function inherited(flags: Record<string, boolean>, o: THREE.Object3D | null, dflt: (o: THREE.Object3D) => boolean): boolean {
  for (let p = o; p; p = p.parent) {
    const id = idOf(p);
    if (id && id in flags) return flags[id];
  }
  return o ? dflt(o) : false;
}

export const isCad = (o: THREE.Object3D): boolean => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.cad) return true;
  return false;
};

export const isLocked = (o: THREE.Object3D) => inherited(state.locked, o, isCad);
export const isHidden = (o: THREE.Object3D) => inherited(state.hidden, o, () => false);

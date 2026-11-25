import type * as THREE from 'three';

/**
 * Per-part working state, persisted to scenes/state.yaml through the dev server.
 * Flags are stored only where set explicitly; descendants inherit from the
 * nearest ancestor that has a flag.
 *
 *  locked  – never moves: skipped by per-frame matrix updates, not scriptable.
 *            CAD defaults to locked, the generated model to unlocked.
 *  hidden  – not drawn. Hidden + locked CAD parts are *suppressed*: their
 *            geometry is freed from GPU and JS memory until shown again.
 */
export interface PartState {
  locked: Record<string, boolean>;
  hidden: Record<string, boolean>;
}

export const state: PartState = { locked: {}, hidden: {} };

export async function loadState() {
  try {
    const r = await fetch('/__state');
    if (r.ok) Object.assign(state, { locked: {}, hidden: {} }, await r.json());
  } catch { /* static build: no state endpoint */ }
}

let saveTimer: number | undefined;
export function saveState() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    fetch('/__state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state) })
      .catch(() => {});
  }, 400);
}

/** Registry id of an object, if it has one (set by build/cad registration). */
const idOf = (o: THREE.Object3D) => (o.userData.id ?? o.name) as string | undefined;

function inherited(flags: Record<string, boolean>, o: THREE.Object3D | null, dflt: (o: THREE.Object3D) => boolean): boolean {
  let first: THREE.Object3D | null = o;
  for (let p = o; p; p = p.parent) {
    const id = idOf(p);
    if (id && id in flags) return flags[id];
  }
  return first ? dflt(first) : false;
}

const isCad = (o: THREE.Object3D): boolean => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData.cad) return true;
  return false;
};

export const isLocked = (o: THREE.Object3D) => inherited(state.locked, o, isCad);
export const isHidden = (o: THREE.Object3D) => inherited(state.hidden, o, () => false);
export { isCad };

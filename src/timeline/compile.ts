import * as THREE from 'three';
import type { BuiltScene } from '../scene/build';

/**
 * Compiles a YAML animation script into a flat list of tweens and step events.
 * Compilation simulates the scene ("virtual state") so every tween knows its
 * start value; playback can then jump to any time deterministically.
 */

export interface Tween { start: number; dur: number; apply: (p: number) => void }
export interface StepEvent { t: number; kind: 'label' | 'cutaway'; value: any; sub?: string }
export interface Timeline { tweens: Tween[]; steps: StepEvent[]; duration: number; camera: CameraRig }
export interface CameraRig { pos: THREE.Vector3; look: THREE.Vector3; initPos: THREE.Vector3; initLook: THREE.Vector3 }

interface VState { pos: THREE.Vector3; color: THREE.Color; opacity: number }

const ease = (p: number) => p * p * (3 - 2 * p);

/** Replace {expr} in strings using vars (+ Math). A string that is only "{expr}" yields the raw value. */
function substitute(node: any, vars: Record<string, any>): any {
  if (typeof node === 'string') {
    const evalExpr = (e: string) =>
      // eslint-disable-next-line no-new-func
      new Function(...Object.keys(vars), `with (Math) { return (${e}); }`)(...Object.values(vars));
    const whole = node.match(/^\{([^{}]+)\}$/);
    if (whole) return evalExpr(whole[1]);
    return node.replace(/\{([^{}]+)\}/g, (_, e) => String(evalExpr(e)));
  }
  if (Array.isArray(node)) return node.map((n) => substitute(n, vars));
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, vars);
    return out;
  }
  return node;
}

const KINDS = ['pick', 'place', 'move', 'highlight', 'fade', 'label', 'cutaway', 'camera', 'wait', 'parallel', 'repeat', 'call'];

export function compile(script: any, scene: BuiltScene, camInit: { pos: number[]; look: number[] }): Timeline {
  const tweens: Tween[] = [];
  const steps: StepEvent[] = [];
  const macros: Record<string, any[]> = script.macros ?? {};
  const bh = scene.blockHeight;
  const baseVars = { bh, floorY: scene.floorY, clear: scene.clearance };

  // virtual state
  const vs = new Map<string, VState>();
  const state = (id: string): VState => {
    let s = vs.get(id);
    if (!s) {
      const obj = scene.registry.get(id);
      if (!obj) throw new Error(`Unknown object id "${id}"`);
      s = { pos: obj.position.clone(), color: firstColor(obj), opacity: 1 };
      vs.set(id, s);
    }
    return s;
  };
  let held: string[] = [];

  const camera: CameraRig = {
    pos: new THREE.Vector3(...camInit.pos), look: new THREE.Vector3(...camInit.look),
    initPos: new THREE.Vector3(...camInit.pos), initLook: new THREE.Vector3(...camInit.look),
  };
  const vCam = { pos: camera.pos.clone(), look: camera.look.clone() };

  // ---- target / point resolution ----
  const resolveTargets = (spec: any): string[] => {
    const list: string[] = Array.isArray(spec) ? spec : [spec];
    const out: string[] = [];
    for (const s of list) {
      if (String(s).includes('*')) {
        const re = new RegExp('^' + String(s).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        for (const id of scene.registry.keys()) if (re.test(id)) out.push(id);
      } else {
        if (!scene.registry.has(String(s))) throw new Error(`Unknown target "${s}"`);
        out.push(String(s));
      }
    }
    return out;
  };

  const pointOf = (spec: any, current: THREE.Vector3): THREE.Vector3 => {
    if (Array.isArray(spec)) return new THREE.Vector3(spec[0], spec[1], spec[2]);
    const p = current.clone();
    if (spec.loc) { const l = scene.locations[spec.loc]; if (!l) throw new Error(`Unknown location "${spec.loc}"`); p.copy(l); }
    if (spec.slot) { const s = scene.slots.get(spec.slot); if (!s) throw new Error(`Unknown slot "${spec.slot}"`); p.copy(s); }
    if (spec.over) { const c = scene.columns.get(spec.over); if (!c) throw new Error(`Unknown column "${spec.over}"`); p.x = c.x; p.z = c.y; }
    if (spec.of) p.copy(state(spec.of).pos);
    for (const a of ['x', 'y', 'z'] as const) if (spec[a] !== undefined) p[a] = spec[a];
    p.x += spec.dx ?? 0; p.y += spec.dy ?? 0; p.z += spec.dz ?? 0;
    return p;
  };

  // ---- primitive tweens ----
  const moveIds = (ids: string[], delta: THREE.Vector3, t: number, dur: number) => {
    for (const id of ids) {
      const obj = scene.registry.get(id)!;
      const s = state(id);
      const from = s.pos.clone(), to = s.pos.clone().add(delta);
      s.pos.copy(to);
      tweens.push({ start: t, dur, apply: (p) => obj.position.lerpVectors(from, to, ease(p)) });
    }
  };
  /** Move primary to dest; carried items follow. Machine always carries what it holds. */
  const moveTo = (primary: string, dest: THREE.Vector3, t: number, dur: number, carry: string[] = []) => {
    const delta = dest.clone().sub(state(primary).pos);
    const ids = [primary, ...carry, ...(primary === 'machine' ? held : [])];
    moveIds([...new Set(ids)], delta, t, dur);
    return t + dur;
  };
  const machineTo = (p: Partial<Record<'x' | 'y' | 'z', number>>, t: number, dur: number) => {
    const d = state('machine').pos.clone();
    if (p.x !== undefined) d.x = p.x; if (p.y !== undefined) d.y = p.y; if (p.z !== undefined) d.z = p.z;
    return moveTo('machine', d, t, dur);
  };
  const colorOf = (c: string) => new THREE.Color(scene.palette[c] ?? c);

  // ---- action runner: returns end time ----
  const run = (raw: any, t: number, vars: Record<string, any>): number => {
    if (raw.at !== undefined) t = raw.at;
    const kind: string = raw.do ?? KINDS.find((k) => k in raw);
    if (!kind) throw new Error(`Can't tell what this action does: ${JSON.stringify(raw)}`);
    // bodies of repeat/parallel are substituted later, with their own loop vars
    const a = kind === 'repeat' || kind === 'parallel' ? raw : substitute(raw, vars);
    const val = a[kind];
    const dur = (d: number) => a.dur ?? d;

    switch (kind) {
      case 'wait': return t + (typeof val === 'number' ? val : dur(1));

      case 'label':
        steps.push({ t, kind: 'label', value: val, sub: a.sub });
        return t + (a.dur ?? 0);

      case 'cutaway':
        steps.push({ t, kind: 'cutaway', value: val });
        return t;

      case 'camera': {
        const from = { pos: vCam.pos.clone(), look: vCam.look.clone() };
        const to = { pos: val.pos ? new THREE.Vector3(...val.pos) : from.pos.clone(), look: val.look ? new THREE.Vector3(...val.look) : from.look.clone() };
        vCam.pos.copy(to.pos); vCam.look.copy(to.look);
        const d = dur(2);
        tweens.push({ start: t, dur: d, apply: (p) => { camera.pos.lerpVectors(from.pos, to.pos, ease(p)); camera.look.lerpVectors(from.look, to.look, ease(p)); } });
        return t + d;
      }

      case 'move': {
        const ids = resolveTargets(a.target ?? val);
        const d = dur(2);
        const carry = a.carry ? resolveTargets(a.carry) : [];
        if (a.by) { moveIds([...new Set([...ids, ...carry, ...(ids.includes('machine') ? held : [])])], new THREE.Vector3(...a.by), t, d); return t + d; }
        return moveTo(ids[0], pointOf(a.to, state(ids[0]).pos), t, d, [...ids.slice(1), ...carry]);
      }

      case 'highlight': {
        const to = colorOf(a.color ?? 'spent');
        const d = dur(0.6);
        for (const id of resolveTargets(a.target ?? val)) {
          const s = state(id), from = s.color.clone(), mats = bodyMaterials(scene.registry.get(id)!);
          s.color = to.clone();
          tweens.push({ start: t, dur: d, apply: (p) => mats.forEach((m) => m.color.lerpColors(from, to, p)) });
        }
        return t + d;
      }

      case 'fade': {
        const d = dur(1);
        for (const id of resolveTargets(a.target ?? val)) {
          const s = state(id), from = s.opacity, to = a.to ?? 0, obj = scene.registry.get(id)!;
          s.opacity = to;
          tweens.push({ start: t, dur: d, apply: (p) => setOpacity(obj, from + (to - from) * p) });
        }
        return t + d;
      }

      case 'pick': {
        // travel at clearance -> descend onto block -> grab -> rise
        const block = resolveTargets(val)[0];
        if (held.length) throw new Error(`pick ${block}: machine is already holding ${held.join(', ')}`);
        const d = dur(5), top = state(block).pos.y + bh / 2, bp = state(block).pos;
        t = machineTo({ y: scene.clearance }, t, d * 0.1);
        t = machineTo({ x: bp.x, z: bp.z }, t, d * 0.35);
        t = machineTo({ y: top }, t, d * 0.25);
        held = [block];
        return machineTo({ y: scene.clearance }, t, d * 0.3);
      }

      case 'place': {
        if (!held.length) throw new Error('place: machine is not holding anything');
        const d = dur(5);
        const spec = typeof val === 'string' ? { slot: val } : val;
        const centre = pointOf(spec, state(held[0]).pos);
        if (spec.loc) centre.y += bh / 2; // locations are surfaces
        t = machineTo({ y: scene.clearance }, t, d * 0.1);
        t = machineTo({ x: centre.x, z: centre.z }, t, d * 0.35);
        t = machineTo({ y: centre.y + bh / 2 }, t, d * 0.25);
        held = [];
        return machineTo({ y: scene.clearance }, t, d * 0.3);
      }

      case 'parallel': {
        let end = t;
        for (const child of raw.parallel) end = Math.max(end, runList(Array.isArray(child) ? child : [child], t, vars));
        return end;
      }

      case 'repeat': {
        const r = substitute({ ...raw.repeat, steps: undefined }, vars);
        const stepN = r.step ?? (r.to >= r.from ? 1 : -1);
        for (let i = r.from; stepN > 0 ? i <= r.to : i >= r.to; i += stepN)
          t = runList(raw.repeat.steps, t, { ...vars, [r.var ?? 'i']: i });
        return t;
      }

      case 'call': {
        const body = macros[a.call];
        if (!body) throw new Error(`Unknown macro "${a.call}"`);
        return runList(body, t, { ...vars, ...(a.args ?? {}) });
      }
    }
    throw new Error(`Unknown action "${kind}"`);
  };

  const runList = (list: any[], t: number, vars: Record<string, any>) => {
    for (const act of list) t = run(act, t, vars);
    return t;
  };

  const duration = runList(script.timeline ?? [], 0, baseVars);
  tweens.sort((x, y) => x.start - y.start);
  steps.sort((x, y) => x.t - y.t);
  return { tweens, steps, duration, camera };
}

export function bodyMaterials(obj: THREE.Object3D): THREE.MeshLambertMaterial[] {
  if ((obj as THREE.Mesh).isMesh) return [(obj as THREE.Mesh).material as THREE.MeshLambertMaterial];
  const out: THREE.MeshLambertMaterial[] = [];
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push((o as THREE.Mesh).material as THREE.MeshLambertMaterial); });
  return out;
}

function firstColor(obj: THREE.Object3D) {
  const m = bodyMaterials(obj)[0];
  return m?.color ? m.color.clone() : new THREE.Color();
}

export function setOpacity(obj: THREE.Object3D, o: number) {
  obj.visible = o > 0.01;
  obj.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.Material | undefined;
    if (!m) return;
    if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity;
    m.transparent = true;
    m.opacity = m.userData.baseOpacity * o;
  });
}

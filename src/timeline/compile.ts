import * as THREE from 'three';
import { withCaps } from '../view/caps';
import type { BuiltScene } from '../scene/build';

/**
 * Compiles a YAML animation script into a flat list of tweens and step events.
 * Compilation simulates the scene ("virtual state") so every tween knows its
 * start value; playback can then jump to any time deterministically.
 */

export interface Tween { start: number; dur: number; apply: (p: number) => void }
export interface StepEvent { t: number; kind: 'label' | 'cutaway' | 'thumbnail'; value: any; sub?: string }
/** Script line -> when that step runs (for the editor's step gutter / run-to). */
export interface LineTiming { start: number; end: number }
export interface Timeline { tweens: Tween[]; steps: StepEvent[]; duration: number; camera: CameraRig; touched: string[]; lines: Map<number, LineTiming> }
/** A compile error that knows which script line caused it. */
export class ScriptError extends Error { constructor(message: string, public line?: number) { super(message); } }
export interface CameraRig { pos: THREE.Vector3; look: THREE.Vector3; initPos: THREE.Vector3; initLook: THREE.Vector3 }

/** Virtual (compile-time) state, all WORLD space. */
interface VState { pos: THREE.Vector3; quat: THREE.Quaternion; color: THREE.Color; base: THREE.Color; opacity: number }

const EASES: Record<string, (p: number) => number> = {
  ease: (p) => p * p * (3 - 2 * p),
  linear: (p) => p,
  in: (p) => p * p,
  out: (p) => 1 - (1 - p) * (1 - p),
};
const ease = EASES.ease;

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

const KINDS = ['list', 'each', 'pick', 'place', 'move', 'rotate', 'pivot', 'highlight', 'fade', 'label', 'cutaway', 'thumbnail', 'camera', 'wait', 'parallel', 'repeat', 'call'];

export function compile(script: any, scene: BuiltScene, camInit: { pos: number[]; look: number[] },
  isLocked: (o: THREE.Object3D) => boolean = () => false,
  groups: Record<string, string[]> = {},
  isRemoved: (o: THREE.Object3D) => boolean = () => false,
  views: Record<string, { pos: number[]; look: number[] }> = {}): Timeline {
  const view = (name: string, line?: number) => {
    const v = views[name];
    if (!v) throw new ScriptError(`Unknown view "${name}"${Object.keys(views).length ? ` – saved views: ${Object.keys(views).join(', ')}` : ' – save one with the Views tool'}`, line);
    return v;
  };
  if ((camInit as any).view) camInit = view((camInit as any).view, (camInit as any).line);
  scene.root.updateMatrixWorld(true); // positions below are world-space
  const tweens: Tween[] = [];
  const steps: StepEvent[] = [];
  const macros: Record<string, any[]> = script.macros ?? {};
  const bh = scene.blockHeight;
  const baseVars = { bh, floorY: scene.floorY, clear: scene.clearance };

  // virtual state
  const vs = new Map<string, VState>();
  /** motion: the step moves it (locked parts can't move; blanking / fading a locked part is fine). */
  const state = (id: string, motion = true): VState => {
    let s = vs.get(id);
    const obj = scene.registry.get(id);
    if (!obj) throw new Error(`Unknown object id "${id}"`);
    if (motion && isLocked(obj)) throw new Error(`"${id}" is locked – unlock it in the assembly tree to animate it`);
    if (!s) {
      if (isRemoved(obj)) throw new Error(`"${id}" is removed from the assembly – restore it to animate it`);
      // virtual state holds WORLD positions; tweens convert to the parent's frame
      s = { pos: obj.getWorldPosition(new THREE.Vector3()), quat: obj.getWorldQuaternion(new THREE.Quaternion()), color: firstColor(obj), base: firstColor(obj), opacity: 1 };
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
  /** script lists (list @x = …), defined in script order */
  const lists = new Map<string, string[]>();
  let names: Map<string, string[]> | undefined;
  /** name → ids: the last segment of each id, and display names (labels) */
  const byName = () => {
    if (!names) {
      names = new Map();
      const add = (k: string, id: string) => { const l = names!.get(k); if (l) { if (!l.includes(id)) l.push(id); } else names!.set(k, [id]); };
      for (const [id, o] of scene.registry) {
        if (isRemoved(o)) continue;
        add(id.slice(id.lastIndexOf('/') + 1), id);
        if (o.userData.label) add(o.userData.label as string, id);
      }
    }
    return names;
  };
  const resolveTargets = (spec: any): string[] => {
    const list: string[] = Array.isArray(spec) ? spec : [spec];
    const out: string[] = [];
    for (const s of list) {
      if (String(s).startsWith('@') && lists.has(String(s))) {   // a script list (list @x = …)
        out.push(...lists.get(String(s))!);
      } else if (String(s).startsWith('@')) {           // user group
        const g = groups[String(s).slice(1)];
        if (!g) throw new Error(`Unknown group "${s}" (create it in the assembly tree, or with list ${s} = …)`);
        for (const id of g) if (scene.registry.has(id) && !isRemoved(scene.registry.get(id)!)) out.push(id); // removed members are skipped
      } else if (String(s).startsWith('~')) {
        // ~text: every part whose name (last id segment, display name or node name) contains text, case-insensitive;
        // top-most matches only (a match's own sub-parts aren't listed again) – like the Select by name tool
        const q = String(s).slice(1).toLowerCase();
        const hit = (o: THREE.Object3D) => {
          const id = (o.userData.id ?? o.name) as string;
          return [id.slice(id.lastIndexOf('/') + 1), String(o.userData.label ?? ''), o.name].some((n) => n.toLowerCase().includes(q));
        };
        const hits: string[] = [];
        for (const [id, o] of scene.registry) {
          if (!q || isRemoved(o) || !hit(o)) continue;
          let covered = false;
          for (let p = o.parent; p && !covered; p = p.parent) if (scene.registry.get((p.userData.id ?? p.name) as string) === p && hit(p)) covered = true;
          if (!covered) hits.push(id);
        }
        if (!hits.length) throw new Error(`No part names contain "${q}"`);
        out.push(...hits.sort((x, y) => x.localeCompare(y, undefined, { numeric: true })));
      } else if (String(s).includes('*')) {
        // a glob over full ids, or over short names (the last id segment) when it has no "/"; natural order
        const re = new RegExp('^' + String(s).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
        const short = !String(s).includes('/');
        const hits = [...scene.registry.keys()].filter((id) => !isRemoved(scene.registry.get(id)!) && (re.test(id) || (short && re.test(id.slice(id.lastIndexOf('/') + 1)))));
        if (!hits.length) throw new Error(`No parts match "${s}"`);
        out.push(...hits.sort((x, y) => x.localeCompare(y, undefined, { numeric: true })));
      } else if (scene.registry.has(String(s))) {
        out.push(String(s));
      } else {
        // a part's name (last segment of its id, e.g. "F1-14-3") or its display name
        const hits = byName().get(String(s)) ?? [];
        if (!hits.length) throw new Error(`Unknown target "${s}"`);
        if (hits.length > 1) throw new Error(`"${s}" names ${hits.length} parts – use the full id (select it in the tree → Copy id)`);
        out.push(hits[0]);
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
  let curEase = ease;
  const moveIds = (ids: string[], delta: THREE.Vector3, t: number, dur: number) => {
    const e = curEase;
    for (const id of ids) {
      const obj = scene.registry.get(id)!;
      const s = state(id);
      const wFrom = s.pos.clone(), wTo = s.pos.clone().add(delta);
      s.pos.copy(wTo);
      // world -> parent-local (parents of moving parts are static: locked CAD or the scene root)
      const from = obj.parent ? obj.parent.worldToLocal(wFrom.clone()) : wFrom;
      const to = obj.parent ? obj.parent.worldToLocal(wTo.clone()) : wTo;
      tweens.push({ start: t, dur, apply: (p) => obj.position.lerpVectors(from, to, e(p)) });
    }
  };

  // ---- rotation about a pivot (world space); pivots travel with their part/group ----
  const localBoxes = new Map<string, THREE.Box3>();
  /** Object's bounding box in its own frame (computed once from the initial pose). */
  const localBox = (id: string) => {
    let b = localBoxes.get(id);
    if (!b) {
      const obj = scene.registry.get(id)!;
      const inv = obj.matrixWorld.clone().invert();
      b = new THREE.Box3();
      obj.traverse((m) => {
        const g = (m as THREE.Mesh).geometry;
        if (!(m as THREE.Mesh).isMesh || !g?.attributes?.position) return;
        g.computeBoundingBox();
        b!.union(g.boundingBox!.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
      });
      localBoxes.set(id, b);
    }
    return b;
  };
  const worldMatrix = (id: string) => {
    const s = state(id), obj = scene.registry.get(id)!;
    return new THREE.Matrix4().compose(s.pos, s.quat, obj.getWorldScale(new THREE.Vector3()));
  };
  /** Default pivot: centre of the targets' bounding box at their current (virtual) pose. */
  const boxCentre = (ids: string[]) => {
    const box = new THREE.Box3();
    for (const id of ids) { const b = localBox(id); if (!b.isEmpty()) box.union(b.clone().applyMatrix4(worldMatrix(id))); }
    return box.isEmpty() ? state(ids[0]).pos.clone() : box.getCenter(new THREE.Vector3());
  };
  /** User pivots, stored in the frame of the target's first member so they follow it. */
  const pivots = new Map<string, { id: string; local: THREE.Vector3 }>();
  const pivotOf = (spec: string, ids: string[]) => {
    const p = pivots.get(spec);
    return p ? p.local.clone().applyMatrix4(worldMatrix(p.id)) : boxCentre(ids);
  };
  const rotateIds = (ids: string[], R: THREE.Quaternion, pivot: THREE.Vector3, t: number, dur: number) => {
    const e = curEase;
    for (const id of ids) {
      const obj = scene.registry.get(id)!;
      const s = state(id);
      const p0 = s.pos.clone(), q0 = s.quat.clone();
      s.pos.sub(pivot).applyQuaternion(R).add(pivot);
      s.quat.premultiply(R);
      const parentInvQ = obj.parent ? obj.parent.getWorldQuaternion(new THREE.Quaternion()).invert() : new THREE.Quaternion();
      const I = new THREE.Quaternion(), Rp = new THREE.Quaternion(), w = new THREE.Vector3(), wq = new THREE.Quaternion();
      tweens.push({ start: t, dur, apply: (p) => {
        Rp.slerpQuaternions(I, R, e(p));
        w.copy(p0).sub(pivot).applyQuaternion(Rp).add(pivot);
        obj.position.copy(obj.parent ? obj.parent.worldToLocal(w) : w);
        obj.quaternion.copy(parentInvQ).multiply(wq.copy(q0).premultiply(Rp));
      } });
    }
  };
  const quatDeg = (v: number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...(v.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ'));
  const materialsOwned = (id: string) => {
    // CAD parts share materials; colour/opacity changes must not leak to other parts
    scene.registry.get(id)!.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.ownMat) return;
      const src = (mesh.userData.origMat ?? mesh.material) as THREE.Material;
      const own = src.clone();
      own.clippingPlanes = src.clippingPlanes;   // clone() copies the planes; keep the live cutaway ones
      withCaps(own);
      if (mesh.userData.origMat) mesh.userData.origMat = own; else mesh.material = own;
      mesh.userData.ownMat = true;
    });
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
  const lines = new Map<number, LineTiming>();
  let recordLines = true; // off for a loop's items after the first (the gutter shows the first item's times)
  const run = (raw: any, t: number, vars: Record<string, any>): number => {
    if (raw.at !== undefined) t = raw.at;
    const t0 = t;
    let end: number;
    try { end = runInner(raw, t, vars); }
    catch (e: any) { throw e instanceof ScriptError ? e : new ScriptError(e.message, raw.line); }
    if (raw.line && recordLines) lines.set(raw.line, { start: t0, end });
    return end;
  };
  const runInner = (raw: any, t: number, vars: Record<string, any>): number => {
    const kind: string = raw.do ?? KINDS.find((k) => k in raw);
    if (!kind) throw new Error(`Can't tell what this action does: ${JSON.stringify(raw)}`);
    // bodies of repeat/parallel are substituted later, with their own loop vars
    const a = kind === 'repeat' || kind === 'parallel' || kind === 'each' ? raw : substitute(raw, vars);
    const val = a[kind];
    const dur = (d: number) => a.dur ?? d;
    curEase = EASES[a.ease ?? 'ease'] ?? ease;

    switch (kind) {
      case 'wait': return t + (typeof val === 'number' ? val : dur(1));

      case 'thumbnail':
        steps.push({ t, kind: 'thumbnail', value: val });
        return t;

      case 'label':
        steps.push({ t, kind: 'label', value: val, sub: a.sub });
        return t + (a.dur ?? 0);

      case 'cutaway': {
        // centre: a point, a target's bounding-box centre (as it is at this time), or the origin
        let at = val?.at as number[] | undefined;
        if (val?.of) {
          const box = new THREE.Box3();
          for (const id of resolveTargets(val.of)) {
            const s = vs.get(id), o = scene.registry.get(id)!;
            const b = new THREE.Box3().setFromObject(o);
            if (s && !b.isEmpty()) b.translate(s.pos.clone().sub(o.getWorldPosition(new THREE.Vector3()))); // moved by the script so far
            box.union(b);
          }
          if (!box.isEmpty()) at = box.getCenter(new THREE.Vector3()).toArray();
        }
        steps.push({ t, kind: 'cutaway', value: typeof val === 'string' ? val : { mode: val.mode, sides: val.sides, at, nocap: val.nocap } });
        return t;
      }

      case 'camera': {
        const from = { pos: vCam.pos.clone(), look: vCam.look.clone() };
        const v = val.view ? view(val.view, a.line) : val;
        const to = { pos: v.pos ? new THREE.Vector3(...v.pos) : from.pos.clone(), look: v.look ? new THREE.Vector3(...v.look) : from.look.clone() };
        vCam.pos.copy(to.pos); vCam.look.copy(to.look);
        const d = dur(2);
        const e = curEase;
        tweens.push({ start: t, dur: d, apply: (p) => { camera.pos.lerpVectors(from.pos, to.pos, e(p)); camera.look.lerpVectors(from.look, to.look, e(p)); } });
        return t + d;
      }

      case 'move': {
        const ids = resolveTargets(a.target ?? val);
        const d = dur(2);
        const carry = a.carry ? resolveTargets(a.carry) : [];
        if (a.by) { moveIds([...new Set([...ids, ...carry, ...(ids.includes('machine') ? held : [])])], new THREE.Vector3(...a.by), t, d); return t + d; }
        if (Array.isArray(a.to)) {
          // absolute: the targets' bounding-box centre goes to the point (all members move together)
          moveIds([...new Set([...ids, ...carry])], new THREE.Vector3(...a.to).sub(boxCentre(ids)), t, d);
          return t + d;
        }
        return moveTo(ids[0], pointOf(a.to, state(ids[0]).pos), t, d, [...ids.slice(1), ...carry]);
      }

      case 'rotate': {
        const spec = Array.isArray(a.target ?? val) ? (a.target ?? val).join(',') : String(a.target ?? val);
        const ids = resolveTargets(Array.isArray(a.target ?? val) ? (a.target ?? val) : spec);
        const d = dur(2);
        const pivot = a.about ? new THREE.Vector3(...a.about) : pivotOf(spec, ids);
        let R: THREE.Quaternion;
        if (a.to) R = quatDeg(a.to).multiply(state(ids[0]).quat.clone().invert()); // absolute orientation of the first member
        else R = quatDeg(a.by ?? [0, 0, 0]);
        rotateIds(ids, R, pivot, t, d);
        return t + d;
      }

      case 'pivot': {
        const spec = String(a.target ?? val);
        const ids = resolveTargets(spec);
        const inv = worldMatrix(ids[0]).invert();
        pivots.set(spec, { id: ids[0], local: new THREE.Vector3(...a.point).applyMatrix4(inv) });
        return t;
      }

      case 'highlight': {
        const reset = a.color === 'reset';
        const d = dur(0.6);
        for (const id of resolveTargets(a.target ?? val)) {
          materialsOwned(id);
          const s = state(id), from = s.color.clone(), mats = bodyMaterials(scene.registry.get(id)!);
          const to = reset ? s.base.clone() : colorOf(a.color ?? 'spent');
          s.color = to.clone();
          tweens.push({ start: t, dur: d, apply: (p) => mats.forEach((m) => m.color.lerpColors(from, to, p)) });
        }
        return t + d;
      }

      case 'fade': {
        const d = dur(1);
        let ids: string[];
        if (a.all) ids = [...vs].filter(([, s]) => s.opacity < 1).map(([id]) => id);   // unblank all: what the script blanked
        else if (a.others) {
          // reverse blank: the top-most parts outside the targets' paths (containers that aren't parts are looked into)
          const sel = resolveTargets(a.target ?? val).map((id) => scene.registry.get(id)!);
          const keep = new Set<THREE.Object3D>();
          for (const o of sel) for (let p: THREE.Object3D | null = o; p; p = p.parent) keep.add(p);
          const out = new Set<string>();
          const off = (c: THREE.Object3D) => {
            if (keep.has(c)) return;
            const id = (c.userData.id ?? c.name) as string;
            if (scene.registry.get(id) === c) { if (!isRemoved(c) && c.visible) out.add(id); } else c.children.forEach(off);
          };
          for (const o of keep) if (!sel.includes(o)) o.children.forEach(off);
          ids = [...out];
        } else ids = resolveTargets(a.target ?? val);
        for (const id of ids) {
          materialsOwned(id);
          const s = state(id, false), from = s.opacity, to = a.to ?? 0, obj = scene.registry.get(id)!;
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

      case 'list': {
        const name = String(a.list);
        if (groups[name.slice(1)]) throw new Error(`${name} is already a group in the assembly tree – use another list name`);
        const ids = [...new Set(resolveTargets(a.items ?? []))];
        lists.set(name, ids);
        return t;
      }

      case 'each': {
        // item i starts at i × stagger (no stagger: after the previous item ends); $ = item, $i = index
        const ids = [...new Set(resolveTargets(raw.each))];
        const order = raw.order as string | undefined;
        if (order) {
          const p = new Map(ids.map((id) => [id, state(id).pos.clone()]));
          if (order === 'random') {
            let seed = ids.length * 2654435761 >>> 0;
            const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
            for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
          } else {
            const neg = order.startsWith('-'), key = order.replace('-', '');
            const c = [...p.values()].reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(Math.max(1, ids.length));
            const val = (id: string) => { const v = p.get(id)!; return key === 'ring' ? Math.hypot(v.x - c.x, v.z - c.z) : v[key as 'x' | 'y' | 'z']; };
            ids.sort((x, y) => (val(x) - val(y)) * (neg ? -1 : 1));
          }
        }
        const stagger = raw.stagger as number | undefined;
        const swap = (node: any, item: string): any =>
          node === '$' ? item : Array.isArray(node) ? node.map((n) => swap(n, item)) : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swap(v, item)])) : node;
        let end = t, start = t;
        ids.forEach((id, i) => {
          recordLines = i === 0;
          const e = runList(swap(raw.steps, id), start, { ...vars, $i: i });
          end = Math.max(end, e);
          start = stagger === undefined ? e : start + stagger;
        });
        recordLines = true;
        return end;
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
  return { tweens, steps, duration, camera, touched: [...vs.keys()], lines };
}

export function bodyMaterials(obj: THREE.Object3D): THREE.MeshLambertMaterial[] {
  // userData.origMat: the real material while the tree's selection highlight is swapped in
  const mat = (m: THREE.Object3D) => (m.userData.origMat ?? (m as THREE.Mesh).material) as THREE.MeshLambertMaterial;
  if ((obj as THREE.Mesh).isMesh) return [mat(obj)];
  const out: THREE.MeshLambertMaterial[] = [];
  obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) out.push(mat(o)); });
  return out;
}

function firstColor(obj: THREE.Object3D) {
  const m = bodyMaterials(obj)[0];
  return m?.color ? m.color.clone() : new THREE.Color();
}

export function setOpacity(obj: THREE.Object3D, o: number) {
  obj.userData.faded = o <= 0.01;
  obj.visible = !obj.userData.faded && !obj.userData.userHidden && !obj.userData.removed;
  obj.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.Material | undefined;
    if (!m) return;
    if (m.userData.baseOpacity === undefined) { m.userData.baseOpacity = m.opacity; m.userData.baseTransparent = m.transparent; }
    m.opacity = m.userData.baseOpacity * o;
    // transparent only while see-through: a transparent double-sided material is drawn in two flipped passes, which
    // breaks the section caps' back-face test (and sorting costs)
    m.transparent = m.opacity < 0.999 || m.userData.baseTransparent === true;
  });
}

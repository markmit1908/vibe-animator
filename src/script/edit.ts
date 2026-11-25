/**
 * Writing direct-manipulation edits (gizmo moves/rotations at a paused time) back into `.anim` text.
 *
 *  - at the end of a step: update that step's move/rotate line for the target, or add one
 *    (a single-line step becomes `parallel { … }`)
 *  - inside a step: split the step at that time (each line becomes two), then edit the first half
 */
import * as THREE from 'three';
import type { AnimDoc, AnimStep, Vec } from './anim';
import type { LineTiming } from '../timeline/compile';

export interface Probe {
  /** World bbox centre of a target (@group or id) right now. */
  centre(target: string): THREE.Vector3;
  /** World orientation of a target's first member right now. */
  quat(target: string): THREE.Quaternion;
  opacity(target: string): number;
  camera(): { pos: number[]; look: number[] };
}

export interface Edit {
  target: string;
  kind: 'move' | 'rotate';
  /** world translation (move) */
  delta?: THREE.Vector3;
  /** world rotation (rotate) */
  rot?: THREE.Quaternion;
  mode: 'by' | 'to';
}

const EPS = 1e-4;
const EASE: Record<string, (p: number) => number> = {
  ease: (p) => p * p * (3 - 2 * p), linear: (p) => p, in: (p) => p * p, out: (p) => 1 - (1 - p) * (1 - p),
};
const r3 = (n: number) => +n.toFixed(3);
const fv = (v: ArrayLike<number>) => `[${r3(v[0])},${r3(v[1])},${r3(v[2])}]`;
const fd = (d: number) => `${r3(d)}s`;
const toDeg = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q, 'XYZ').toArray().slice(0, 3).map((a) => THREE.MathUtils.radToDeg(a as number));
const fromDeg = (v: number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...(v.map(THREE.MathUtils.degToRad) as [number, number, number]), 'XYZ'));

/** Line text from step fields (used when splitting / adding). */
function lineOf(s: { verb: string; target?: string; mode?: string; vec?: number[]; about?: number[]; look?: number[]; num?: number; word?: string; text?: string[]; dur?: number; ease?: string }) {
  const p: string[] = [s.verb];
  if (s.target) p.push(s.target);
  if (s.verb === 'fade') p.push('to', String(r3(s.num ?? 0)));
  if (s.verb === 'camera') { p.push(fv(s.vec!)); if (s.look) p.push('look', fv(s.look)); }
  else if (s.mode && s.vec) p.push(s.mode, fv(s.vec));
  else if (s.vec) p.push(fv(s.vec));
  if (s.about) p.push('about', fv(s.about));
  if (s.word) p.push(s.word);
  if (s.text) p.push(...s.text.map((t) => JSON.stringify(t)));
  if (s.dur !== undefined && s.dur > 0) p.push(fd(s.dur));
  if (s.ease && s.ease !== 'ease') p.push(s.ease);
  return p.join(' ');
}

const fields = (s: AnimStep) => ({
  verb: s.verb, target: s.target?.value, mode: s.mode?.value, vec: s.vec?.value, about: s.about?.value, look: s.look?.value,
  num: s.num?.value, word: s.word?.value, text: s.text?.map((t) => t.value), dur: s.dur?.value, ease: s.ease?.value,
});

interface Found { step: AnimStep; start: number; end: number }

/** The top-level step running at time t (a step that ends exactly at t wins). */
function stepAt(doc: AnimDoc, lines: Map<number, LineTiming>, t: number): Found | undefined {
  let best: Found | undefined;
  for (const s of doc.steps) {
    const x = lines.get(s.line);
    if (!x) continue;
    if (Math.abs(x.end - t) < EPS && x.end > x.start) return { step: s, ...x };
    if (t > x.start - EPS && t < x.end - EPS) best = { step: s, ...x };
  }
  return best;
}

const lineRange = (text: string, line: number) => {
  const ls = text.split('\n');
  let from = 0;
  for (let i = 0; i < line - 1; i++) from += ls[i].length + 1;
  return { from, to: from + ls[line - 1].length, text: ls[line - 1] };
};
const indentOf = (s: string) => s.match(/^\s*/)![0];

/** Split one line at fraction f of its own duration. Returns [first, second] (either may be empty). */
function splitLine(s: AnimStep, f: number, probe: Probe): [string?, string?] {
  const F = fields(s);
  const d = F.dur ?? 0;
  if (f >= 1 - EPS) return [lineOf(F), undefined];
  if (f <= EPS) return [undefined, lineOf(F)];
  const e = EASE[F.ease ?? 'ease'] ?? EASE.ease;
  const a = { ...F, dur: d * f }, b = { ...F, dur: d * (1 - f) };
  switch (s.verb) {
    case 'move':
      if (F.mode === 'by') { const v = F.vec!; a.vec = v.map((x) => x * e(f)) as Vec; b.vec = v.map((x, i) => x - a.vec![i]) as Vec; }
      else a.vec = probe.centre(F.target!).toArray() as Vec;
      break;
    case 'rotate':
      if (F.mode === 'by') {
        const R = fromDeg(F.vec!), R1 = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), R, e(f));
        a.vec = toDeg(R1) as Vec; b.vec = toDeg(R.clone().multiply(R1.clone().invert())) as Vec;
      } else a.vec = toDeg(probe.quat(F.target!)) as Vec;
      break;
    case 'fade': case 'hide': case 'show':
      a.verb = b.verb = 'fade'; b.num = F.verb === 'hide' ? 0 : F.verb === 'show' ? 1 : F.num; a.num = probe.opacity(F.target!);
      break;
    case 'camera': { const c = probe.camera(); a.vec = c.pos as Vec; a.look = c.look as Vec; break; }
    case 'wait': return [`wait ${fd(d * f)}`, `wait ${fd(d * (1 - f))}`];
    default: return [lineOf(F), undefined]; // label, cutaway, pivot, highlight: keep in the first half
  }
  return [lineOf(a), lineOf(b)];
}

/** Apply an edit at time t. Returns the new text, or undefined if there's no step at t. */
export function applyEdit(text: string, doc: AnimDoc, lines: Map<number, LineTiming>, t: number, edit: Edit, probe: Probe): string | undefined {
  let found = stepAt(doc, lines, t);
  if (!found) return appendStep(text, edit, probe, 1);
  // a loop is a template for many items: edits go into a new step after it
  if (found.step.verb === 'each') return appendStep(text, edit, probe, 1, found.step.endLine ?? found.step.line);

  // ---- inside the step: split it at t ----
  if (t < found.end - EPS) {
    const s = found.step;
    const r = s.children ? { from: lineRange(text, s.line).from, to: lineRange(text, s.endLine!).to } : lineRange(text, s.line);
    const ind = indentOf(lineRange(text, s.line).text);
    let first: string, second: string;
    if (s.children) {
      const halves = s.children.map((c) => {
        const x = lines.get(c.line)!;
        return splitLine(c, x.end > x.start ? (t - x.start) / (x.end - x.start) : 1, probe);
      });
      const block = (ls: (string | undefined)[]) => {
        const body = ls.filter(Boolean) as string[];
        if (!body.length) return '';
        return `${ind}parallel {\n${body.map((l) => `${ind}  ${l}`).join('\n')}\n${ind}}`;
      };
      first = block(halves.map((h) => h[0])); second = block(halves.map((h) => h[1]));
    } else {
      const [a, b] = splitLine(s, (t - found.start) / (found.end - found.start), probe);
      first = a ? ind + a : ''; second = b ? ind + b : '';
    }
    text = text.slice(0, r.from) + [first, second].filter(Boolean).join('\n') + text.slice(r.to);
    return { pending: true, text } as any; // caller re-parses + recompiles, then calls again at the step end
  }

  // ---- at the end of the step: update or add a line for this target ----
  const s = found.step;
  const dur = found.end - found.start;
  const candidates = s.children ?? [s];
  const hit = candidates.find((c) => c.verb === edit.kind && c.target?.value === edit.target);
  if (hit) {
    const F = fields(hit);
    if (edit.kind === 'move') F.vec = (F.mode === 'to' ? new THREE.Vector3(...F.vec!).add(edit.delta!) : new THREE.Vector3(...F.vec!).add(edit.delta!)).toArray() as Vec;
    else F.vec = toDeg(F.mode === 'to' ? edit.rot!.clone().multiply(fromDeg(F.vec!)) : edit.rot!.clone().multiply(fromDeg(F.vec!))) as Vec;
    const r = lineRange(text, hit.line);
    return text.slice(0, r.from) + indentOf(r.text) + lineOf(F) + text.slice(r.to);
  }
  const added = newLine(edit, probe, dur);
  if (dur <= EPS) return appendStep(text, edit, probe, 1, s.endLine ?? s.line); // instant step: add a 1 s step after it
  if (s.children) {
    const close = lineRange(text, s.endLine!);
    return text.slice(0, close.from) + `${indentOf(lineRange(text, s.line).text)}  ${added}\n` + text.slice(close.from);
  }
  const r = lineRange(text, s.line);
  const ind = indentOf(r.text);
  return text.slice(0, r.from) + `${ind}parallel {\n${ind}  ${r.text.trim()}\n${ind}  ${added}\n${ind}}` + text.slice(r.to);
}

function newLine(edit: Edit, probe: Probe, dur: number) {
  if (edit.kind === 'move') {
    const vec = edit.mode === 'to' ? probe.centre(edit.target).toArray() : edit.delta!.toArray();
    return lineOf({ verb: 'move', target: edit.target, mode: edit.mode, vec, dur });
  }
  const vec = edit.mode === 'to' ? toDeg(probe.quat(edit.target)) : toDeg(edit.rot!);
  return lineOf({ verb: 'rotate', target: edit.target, mode: edit.mode, vec, dur });
}

/** Add the edit as its own step after `afterLine` (default: end of script). */
function appendStep(text: string, edit: Edit, probe: Probe, dur: number, afterLine?: number) {
  const l = newLine(edit, probe, dur);
  if (afterLine === undefined) return text.replace(/\n*$/, '\n') + l + '\n';
  const r = lineRange(text, afterLine);
  return text.slice(0, r.to) + '\n' + l + text.slice(r.to);
}

/** Camera key: insert `camera … 2s` as a step after the cursor line. */
export function cameraLine(probe: Probe) {
  const c = probe.camera();
  return lineOf({ verb: 'camera', vec: c.pos, look: c.look, dur: 2 });
}

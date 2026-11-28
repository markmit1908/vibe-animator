/**
 * Read-only assist tools: browse/search the assembly, inspect parts, check a draft script,
 * and look at the scene (screenshot). They run in the browser against the live scene.
 */
import * as THREE from 'three';
import type { AssistEvent, AssistTool, ToolResult } from './loop';
import { KINDS, SIZES, validName, type ShapeDef, type ShapeKind } from '../scene/shapes';
import type { CopyDef } from '../scene/copies';

export interface ToolDeps {
  registry: Map<string, THREE.Object3D>;
  groups: () => Record<string, string[]>;
  isLocked: (o: THREE.Object3D) => boolean;
  isHidden: (o: THREE.Object3D) => boolean;
  /** Parse + compile a draft script without changing anything. */
  /** Parse + compile without applying. Locked parts are not errors here; they are listed in `locked` (targets the script moves that are locked). */
  checkScript: (text: string) => { errors: { line: number; message: string }[]; duration?: number; steps?: { line: number; start: number; end: number; text: string }[]; locked?: string[] };
  /** Render a view to a JPEG (base64), optionally framing a target. */
  screenshot: (view: string, target?: string) => { data: string; width: number; height: number; note: string };
  /** Top-level roots of the assembly (CAD model wrappers / generated parts). */
  roots: () => THREE.Object3D[];
  /** Annotations about a part (on it, a group or folder holding it, or one of its ancestors): "a1 \"Title\"". */
  annotationsOn?: (id: string) => string[];
}

const idOf = (o: THREE.Object3D) => (o.userData.id ?? o.name) as string;
const r2 = (n: number) => +n.toFixed(2);
const v3 = (v: THREE.Vector3) => `[${r2(v.x)}, ${r2(v.y)}, ${r2(v.z)}]`;
const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
const kids = (o: THREE.Object3D) => o.children.filter((c) => (c.userData.id || c.userData.kind === 'block') && !c.userData.removed);

function flags(o: THREE.Object3D, d: ToolDeps) {
  return [d.isLocked(o) ? 'locked' : 'unlocked', d.isHidden(o) ? 'hidden' : ''].filter(Boolean).join(', ');
}
/** Skip single-child wrapper levels (as the tree panel shows them). */
function compact(o: THREE.Object3D) {
  while (kids(o).length === 1 && !(o as THREE.Mesh).isMesh) o = kids(o)[0];
  return o;
}

// small schema validator: required keys + primitive types
function check(input: any, spec: Record<string, 'string' | 'number' | 'string?' | 'number?'>) {
  if (!input || typeof input !== 'object') return 'input must be an object';
  for (const [k, t] of Object.entries(spec)) {
    const opt = t.endsWith('?'), want = t.replace('?', '');
    if (input[k] === undefined) { if (!opt) return `missing "${k}"`; continue; }
    if (typeof input[k] !== want) return `"${k}" must be a ${want}`;
  }
}

async function* done(r: ToolResult): AsyncGenerator<never, ToolResult, void> { return r; }

export function readTools(d: ToolDeps): AssistTool[] {
  return [
    {
      name: 'find_parts',
      description: 'Search the assembly tree for parts/assemblies whose id or name contains the query (case-insensitive; * is a wildcard). Returns ids usable in the script, with child counts, lock/hide state and size. Use it to find ids before writing script lines.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Text or glob, e.g. "V-005738" or "F2-17*"' }, limit: { type: 'number', description: 'Max results (default 40)' } }, required: ['query'] },
      validate: (i) => check(i, { query: 'string', limit: 'number?' }),
      run(i) {
        const q = String(i.query).toLowerCase();
        const re = q.includes('*') ? new RegExp(q.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')) : undefined;
        const lim = Math.min(Math.max(1, i.limit ?? 40), 200);
        const hits: string[] = [];
        let total = 0;
        for (const [id, o] of d.registry) {
          if (o.userData.removed) continue; // removed from this animation's assembly
          const name = `${o.name || ''} ${o.userData.label ?? ''}`.toLowerCase(), lid = id.toLowerCase();
          if (re ? !(re.test(lid) || re.test(name)) : !(lid.includes(q) || name.includes(q))) continue;
          total++;
          if (hits.length < lim) hits.push(`${id} | ${o.userData.label ? `"${o.userData.label}" ` : ''}${o.name || '-'} | ${kids(o).length} children | ${flags(o, d)} | size ${v3(box(o).getSize(new THREE.Vector3()))} m`);
        }
        return done({ content: total ? `${total} match${total > 1 ? 'es' : ''}${total > lim ? ` (first ${lim})` : ''}:\n${hits.join('\n')}` : `No parts match "${i.query}".` });
      },
    },
    {
      name: 'get_part',
      description: 'Details of one part/assembly by id: world bounding box (min, max, size, centre) in metres, position, lock/hide state, groups it belongs to, and its children (ids).',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      validate: (i) => check(i, { id: 'string' }),
      run(i) {
        const o = d.registry.get(i.id);
        if (!o) return done({ content: `No part with id "${i.id}". Use find_parts to search.`, is_error: true });
        const b = box(o);
        const groups = Object.entries(d.groups()).filter(([, ids]) => ids.some((g) => g === i.id || i.id.startsWith(`${g}/`))).map(([g]) => `@${g}`);
        const ch = kids(o);
        return done({ content: [
          `id: ${i.id}`, `name: ${o.name || '-'}`, `state: ${flags(o, d)}`,
          b.isEmpty() ? 'bbox: (no geometry)' : `bbox: min ${v3(b.min)} max ${v3(b.max)} size ${v3(b.getSize(new THREE.Vector3()))} centre ${v3(b.getCenter(new THREE.Vector3()))}`,
          `world position: ${v3(o.getWorldPosition(new THREE.Vector3()))}`,
          `groups: ${groups.join(', ') || 'none'}`,
          ...(d.annotationsOn ? [`annotations: ${d.annotationsOn(i.id).join(', ') || 'none'}`] : []),
          `children (${ch.length}):${ch.slice(0, 60).map((c) => `\n  ${idOf(c)}`).join('')}${ch.length > 60 ? `\n  … ${ch.length - 60} more` : ''}`,
        ].join('\n') });
      },
    },
    {
      name: 'get_tree',
      description: 'The assembly tree under a node (or from the top), as an indented outline of ids with child counts. Single-child wrapper levels are skipped. Use depth 1–3; large branches are truncated.',
      input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Start node id (omit for the top)' }, depth: { type: 'number', description: 'Levels to show (default 2)' } } },
      validate: (i) => check(i, { id: 'string?', depth: 'number?' }),
      run(i) {
        const start = i.id ? d.registry.get(i.id) : undefined;
        if (i.id && !start) return done({ content: `No part with id "${i.id}".`, is_error: true });
        const depth = Math.min(Math.max(1, i.depth ?? 2), 5);
        const out: string[] = [];
        const MAX = 400;
        const walk = (o: THREE.Object3D, lvl: number) => {
          if (out.length >= MAX) return;
          const c = compact(o), ch = kids(c);
          out.push(`${'  '.repeat(lvl)}${idOf(c)}${ch.length ? `  [${ch.length}]` : ''}${d.isHidden(c) ? ' (hidden)' : ''}`);
          if (lvl + 1 < depth) {
            // group identical sibling names to keep it short
            const byName = new Map<string, THREE.Object3D[]>();
            for (const k of ch) { const n = (k.name || idOf(k)).replace(/_\d+$/, ''); (byName.get(n) ?? byName.set(n, []).get(n)!).push(k); }
            for (const [, list] of byName) {
              if (list.length > 3) { walk(list[0], lvl + 1); out.push(`${'  '.repeat(lvl + 1)}… and ${list.length - 1} more like it`); }
              else list.forEach((k) => walk(k, lvl + 1));
            }
          }
        };
        (start ? [start] : d.roots()).forEach((o) => walk(o, 0));
        if (out.length >= MAX) out.push('… (truncated – start deeper with id)');
        return done({ content: out.join('\n') || '(empty)' });
      },
    },
    {
      name: 'check_script',
      description: 'Parse and compile a complete draft .anim script without applying it. Returns errors (line: message) or the duration and each step\'s start–end time. Only for looking at timings or trying ideas – the propose tools compile the script themselves.',
      input_schema: { type: 'object', properties: { text: { type: 'string', description: 'The whole script' } }, required: ['text'] },
      writing: 'a draft script',
      validate: (i) => check(i, { text: 'string' }),
      async *run(i) {
        yield { type: 'tool', name: 'check_script', label: 'checked a draft script' };
        const r = d.checkScript(i.text);
        if (r.errors.length) return { content: `${r.errors.length} error(s):\n${r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}` };
        const lockNote = r.locked?.length ? `\nLocked targets (fine – propose_script_edit unlocks them when the user accepts): ${r.locked.join(', ')}` : '';
        return { content: `OK – duration ${r.duration?.toFixed(1)} s${lockNote}\n${(r.steps ?? []).map((s) => `line ${s.line} [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text}`).join('\n')}` };
      },
    },
    {
      name: 'screenshot',
      description: 'Look at the scene. view: "current" (the user\'s view), or "iso" / "top" / "front" / "side" framed on the target (or the whole scene). Returns an image.',
      input_schema: { type: 'object', properties: { view: { type: 'string', enum: ['current', 'iso', 'top', 'front', 'side'] }, target: { type: 'string', description: 'Part id or @group to frame (optional)' } }, required: ['view'] },
      validate: (i) => check(i, { view: 'string', target: 'string?' }) ?? (['current', 'iso', 'top', 'front', 'side'].includes(i.view) ? undefined : 'view must be current|iso|top|front|side'),
      async *run(i) {
        yield { type: 'tool', name: 'screenshot', label: `looked at the ${i.view} view${i.target ? ` of ${i.target}` : ''}` };
        const s = d.screenshot(i.view, i.target);
        return { content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.data } },
          { type: 'text', text: `${s.width}×${s.height}. ${s.note}` },
        ] };
      },
    },
  ];
}

// ---------------------------------------------------------------- proposals
export interface ProposeDeps {
  checkScript: ToolDeps['checkScript'];
  currentScript: () => string;
}

/** Proposal tools: they never change anything – they show a card the user accepts or rejects. */
export function proposeTools(d: ProposeDeps): AssistTool[] {
  return [
    {
      name: 'propose_script_edit',
      description: 'Propose a new version of the whole .anim script. The user sees a diff with a compile check and can preview, accept or reject it. Send the COMPLETE script text, keeping lines you are not changing exactly as they are. For a change to part of the script use propose_script_patch instead (faster). It compiles the script itself and reports errors – no need to call check_script first.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The complete new script' },
          summary: { type: 'string', description: 'One line: what changes, e.g. "Lift @lid 3 m over 6 s, then slide it aside"' },
        },
        required: ['text', 'summary'],
      },
      writing: 'a script edit',
      validate: (i) => check(i, { text: 'string', summary: 'string' }),
      async *run(i) { return yield* propose(i.text, i.summary); },
    },
    {
      name: 'propose_script_patch',
      description: 'Propose a change to the .anim script as small edits – preferred for changes to part of the script (much faster than sending the whole script). Each edit replaces one exact piece of the current script text ("find", copied from the script text without the line-number prefixes shown in the context; it must occur exactly once – include a whole line or two for context) with "replace" (empty to delete; to insert, find a line and replace it with that line plus the new ones). The edits apply in order. The user sees the diff with a compile check, and can preview, accept or reject it.',
      input_schema: {
        type: 'object',
        properties: {
          edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] }, description: 'Exact find/replace edits, applied in order' },
          summary: { type: 'string', description: 'One line: what changes' },
        },
        required: ['edits', 'summary'],
      },
      writing: 'a script edit',
      validate: (i) => {
        const bad = check(i, { summary: 'string' });
        if (bad) return bad;
        if (!Array.isArray(i.edits) || !i.edits.length) return '"edits" must be a non-empty array';
        for (const e of i.edits) if (!e || typeof e.find !== 'string' || typeof e.replace !== 'string' || !e.find) return 'each edit needs a non-empty "find" and a "replace" string';
      },
      async *run(i) {
        let text = d.currentScript();
        for (const [k, e] of (i.edits as { find: string; replace: string }[]).entries()) {
          const at = text.indexOf(e.find);
          if (at < 0) return { content: `Edit ${k + 1}: "find" text not found in the script (it must match exactly, including spaces). Nothing proposed.`, is_error: true };
          if (text.indexOf(e.find, at + 1) >= 0) return { content: `Edit ${k + 1}: "find" text occurs more than once – include more surrounding text. Nothing proposed.`, is_error: true };
          text = text.slice(0, at) + e.replace + text.slice(at + e.find.length);
        }
        return yield* propose(text, i.summary);
      },
    },
  ];

  /** A script proposal from the complete new text: compile check, locked parts to unlock, the card. */
  async function* propose(text0: string, summary: string): AsyncGenerator<AssistEvent, ToolResult, void> {
        const base = d.currentScript();
        const text = text0.endsWith('\n') ? text0 : `${text0}\n`;
        if (text === base) return { content: 'That is identical to the current script – nothing to propose.', is_error: true };
        const r = d.checkScript(text);
        const ok = r.errors.length === 0;
        const unlock = r.locked ?? [];
        const names = unlock.slice(0, 4).map((x) => x.split('/').pop()).join(', ') + (unlock.length > 4 ? ` … ${unlock.length - 4} more` : '');
        const label = ok ? `✓ compiles · ${r.duration?.toFixed(1)} s${unlock.length ? ` · unlocks ${unlock.length} part${unlock.length === 1 ? '' : 's'}` : ''}` : `${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'script edit', summary, check: { ok, label }, base, text, errors: r.errors, unlock };
        return {
          content: ok
            ? `Proposed (${label}).${unlock.length ? ` Accepting it also unlocks the ${unlock.length} locked part(s) it animates (${names}), so don't propose a separate unlock.` : ''} The user will preview/accept or reject it; don't repeat the script in your reply – summarise the change in a sentence or two.`
            : `Proposed, but it does not compile:\n${r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}\nNothing was applied – propose again with all your edits, fixed (still against the current script).`,
        };
  }
}


/** Line diff (LCS) for proposal cards: [' '|'+'|'-', line]. */
export function lineDiff(a: string, b: string): [string, string][] {
  const A = a.replace(/\n$/, '').split('\n'), B = b.replace(/\n$/, '').split('\n');
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: [string, string][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([' ', A[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(['-', A[i++]]);
    else out.push(['+', B[j++]]);
  }
  while (i < n) out.push(['-', A[i++]]);
  while (j < m) out.push(['+', B[j++]]);
  return out;
}

// ---------------------------------------------------------------- group / state proposals
export interface ModelProposeDeps {
  /** Expand ids, globs (*) and @groups to registry ids; unknown entries are returned separately. */
  resolve: (specs: string[]) => { ids: string[]; unknown: string[] };
  groups: () => Record<string, string[]>;
  /** The studio's shapes (basic modelling). */
  shapes?: () => ShapeDef[];
  /** Work out a placement change at the start pose: the rigid world transform for the targets, before/after boxes. */
  planPlacement?: (c: PlacementInput) => PlacementPlan;
  /** The studio's linked copies, and the box centre of what a copy would copy (null when nothing matches). */
  copies?: () => CopyDef[];
  sourcesCentre?: (of: string[]) => { centre: number[] | null; unknown: string[] };
  /** Annotations as the assistant sees them (parts resolved now, the anchor's world point). */
  annotations?: () => AnnotationInfo[];
  /** An annotation target → how many parts it covers now, and what didn't resolve. */
  annotationTarget?: (target: string) => { parts: number; unknown: string[] };
}
export interface AnnotationInfo { id: string; title: string; note: string; target: string; parts: string[]; point: number[] | null; show: boolean }
/** One annotation change, checked (create: a new id is given at accept time). */
export interface AnnotationChange { action: 'create' | 'update' | 'delete'; id?: string; title?: string; note?: string; target?: string; point?: number[]; show?: boolean; parts?: number;
  /** its target is a copy proposed in this conversation, not accepted yet (it resolves once the copy exists) */
  pending?: boolean }

/** Copies proposed in this session (not accepted yet): annotations may target them – they resolve once accepted. */
const proposedCopies = new Set<string>();
/** A target naming only proposed copies ("copies/X", "X", "copies/X-0"…, lists of them). */
function onProposedCopies(target: string): boolean {
  const items = target.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length > 0 && items.every((t) => { const n = t.replace(/^copies\//, '').split('/')[0]; return proposedCopies.has(n) || proposedCopies.has(n.replace(/-\d+$/, '')); });
}

function annotationChanges(input: any[], d: ModelProposeDeps): { changes: AnnotationChange[]; problems: string[] } {
  const problems: string[] = [], changes: AnnotationChange[] = [];
  const have = new Set(d.annotations!().map((a) => a.id));
  for (const c of input) {
    const action = c.action;
    if (!['create', 'update', 'delete'].includes(action)) { problems.push(`unknown action "${action}"`); continue; }
    if (action !== 'create' && !have.has(String(c.id ?? ''))) { problems.push(`no annotation "${c.id}" (get_annotations lists them)`); continue; }
    if (action === 'delete') { changes.push({ action, id: String(c.id) }); continue; }
    const ch: AnnotationChange = { action, ...(action === 'update' ? { id: String(c.id) } : {}) };
    if (c.title !== undefined) ch.title = String(c.title).trim();
    if (c.note !== undefined) ch.note = String(c.note);
    if (c.show !== undefined) ch.show = !!c.show;
    if (action === 'create' && !ch.title) problems.push('create: a title');
    if (c.target !== undefined || action === 'create') {
      const t = String(c.target ?? '').trim();
      if (!t) { problems.push(`${ch.title || ch.id}: target – part ids / names, @group or folder:Path`); continue; }
      const res = d.annotationTarget!(t);
      if ((res.unknown.length || !res.parts) && onProposedCopies(t)) { ch.target = t; ch.parts = 0; ch.pending = true; changes.push(ch); continue; }   // a copy proposed in this conversation: resolves once it's accepted
      if (res.unknown.length) problems.push(`${ch.title || ch.id}: unknown ${res.unknown.join(', ')}`);
      else if (!res.parts) problems.push(`${ch.title || ch.id}: "${t}" covers no parts`);
      ch.target = t; ch.parts = res.parts;
    }
    if (c.point !== undefined && c.point !== null) {
      if (!Array.isArray(c.point) || c.point.length !== 3 || c.point.some((x: unknown) => !Number.isFinite(Number(x)))) problems.push(`${ch.title || ch.id}: point must be [x, y, z]`);
      else ch.point = c.point.map(Number);
    }
    changes.push(ch);
  }
  return { changes, problems };
}

/** One linked-copy change, checked: the full new definition (create/update) or the name (delete). */
export interface CopyChange { action: 'create' | 'update' | 'delete'; name: string; rename?: string; def?: CopyDef; centre?: number[] }

function copyChanges(input: any[], d: ModelProposeDeps): { changes: CopyChange[]; problems: string[] } {
  const problems: string[] = [], changes: CopyChange[] = [];
  const existing = d.copies!();
  const names = new Set(existing.map((c) => c.id));
  for (const c of input) {
    const name = String(c.name ?? '').trim(), action = c.action;
    if (!['create', 'update', 'delete'].includes(action)) { problems.push(`unknown action "${action}"`); continue; }
    if (!validName(name)) { problems.push(`bad copy name "${name}" (letters, digits, - _; not starting with a digit)`); continue; }
    if (action === 'create' ? names.has(name) : !names.has(name)) { problems.push(action === 'create' ? `a copy "${name}" already exists (use update)` : `no copy "${name}"`); continue; }
    if (action === 'delete') { names.delete(name); changes.push({ action, name }); continue; }
    const base = existing.find((x) => x.id === name);
    const of: string[] = Array.isArray(c.of) ? c.of.map(String) : base?.of ?? [];
    if (!of.length) { problems.push(`${name}: "of" – what to copy (part ids, names, @groups)`); continue; }
    const src = d.sourcesCentre!(of);
    if (src.unknown.length) problems.push(`${name}: unknown ${src.unknown.join(', ')}`);
    if (!src.centre) { problems.push(`${name}: nothing to copy in ${of.join(', ')}`); continue; }
    const v3 = (v: unknown, what: string) => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) { problems.push(`${name}: ${what} must be [x, y, z]`); return undefined; }
      return v.map(Number);
    };
    const pos = v3(c.position, 'position'), off = v3(c.offset, 'offset');
    if (pos && off) problems.push(`${name}: give position or offset, not both`);
    const position = pos ?? (off ? src.centre.map((x, i) => x + off[i]) : base?.position ?? src.centre);
    const rotation = v3(c.rotation, 'rotation') ?? base?.rotation ?? [0, 0, 0];
    let mirror = c.mirror === null ? undefined : (c.mirror ?? base?.mirror);
    if (mirror !== undefined && !['x', 'y', 'z'].includes(mirror)) { problems.push(`${name}: mirror is x, y or z`); mirror = undefined; }
    let array = c.array === null ? undefined : base?.array;
    if (noArray(c.array)) { if (c.array === null || Object.keys(c.array).length) array = undefined; }   // {} = no change
    else if (c.array) {
      const n = Math.round(Number(c.array.count));
      if (!(n >= 2 && n <= 500)) problems.push(`${name}: array count must be 2..500`);
      if (c.array.type === 'linear') array = { type: 'linear', count: n, step: v3(c.array.step, 'array step') ?? [1, 0, 0] };
      else if (c.array.type === 'circular') {
        const ce = c.array.centre ?? [0, 0];
        if (!Array.isArray(ce) || ce.length !== 2) problems.push(`${name}: circular array centre is [x, z]`);
        array = { type: 'circular', count: n, centre: (Array.isArray(ce) ? ce : [0, 0]).map(Number), angle: Number(c.array.angle ?? 360) };
      } else problems.push(`${name}: array.type is "linear" or "circular" (leave array out for a single one)`);
    }
    let rename: string | undefined;
    if (action === 'update' && c.rename && c.rename !== name) {
      rename = String(c.rename).trim();
      if (!validName(rename) || names.has(rename)) problems.push(`can't rename ${name} to "${rename}"`);
      else { names.delete(name); names.add(rename); }
    }
    if (action === 'create') names.add(name);
    const r4 = (v: number[]) => v.map((x) => +x.toFixed(4));
    const def: CopyDef = { id: rename ?? name, of, position: r4(position), rotation: r4(rotation), ...(mirror ? { mirror } : {}), ...(array ? { array } : {}) };
    changes.push({ action, name, rename, def, centre: r4(src.centre) });
  }
  return { changes, problems };
}

export interface PlacementInput {
  targets: string[];
  move_by?: number[];
  move_to?: number[];
  anchor?: 'centre' | 'bottom' | 'top';
  rotate?: { axis: 'x' | 'y' | 'z' | number[]; degrees: number; pivot?: number[] };
  reset?: boolean;
}
export interface PlacementPlan {
  targets: string[];
  ids: string[];
  /** world transform applied to every target (column-major 4×4), or undefined for reset */
  matrix?: number[];
  reset?: boolean;
  before?: { centre: number[]; min: number[]; max: number[] };
  after?: { centre: number[]; min: number[]; max: number[] };
  move?: number[];
  rotate?: { axis: number[]; degrees: number };
  problems: string[];
}

/** Size field names per kind for the assistant: "outer radius" → outer_radius, "width (x)" → width. */
export const sizeKeys = (k: ShapeKind) => SIZES[k].map((f) => f.label.replace(/\s*\(.*\)/, '').trim().replace(/\s+/g, '_'));
const SIZE_DOC = KINDS.map((k) => `${k} {${sizeKeys(k).join(', ')}}`).join('; ');
/** No array wanted: null, {}, or an array with type none/off/single (models send these). */
const noArray = (a: any) => a === null || (typeof a === 'object' && a !== null && (!Object.keys(a).length || ['none', 'off', 'single', ''].includes(String(a.type ?? 'x').toLowerCase())));
const ARRAY_SCHEMA = {
  type: ['object', 'null'],
  description: 'Optional – leave it out for a single one; null removes an existing array. linear: {type: "linear", count, step [x,y,z] m}; circular: {type: "circular", count, centre [x,z] of a vertical axis, angle (360 = evenly round)}',
  properties: {
    type: { type: 'string', enum: ['linear', 'circular'] },
    count: { type: 'integer', minimum: 2 },
    step: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    centre: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    angle: { type: 'number' },
  },
  required: ['type', 'count'],
};
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

/** One shape change, checked: the full new definition (create/update) or the name (delete). */
export interface ShapeChange { action: 'create' | 'update' | 'delete'; name: string; rename?: string; def?: ShapeDef }

function shapeChanges(input: any[], existing: ShapeDef[]): { changes: ShapeChange[]; problems: string[] } {
  const problems: string[] = [];
  const names = new Set(existing.map((s) => s.id));
  const changes: ShapeChange[] = [];
  for (const c of input) {
    const name = String(c.name ?? '').trim();
    const action = c.action;
    if (!['create', 'update', 'delete'].includes(action)) { problems.push(`unknown action "${action}"`); continue; }
    if (action === 'create' ? names.has(name) : !names.has(name)) { problems.push(action === 'create' ? `a shape "${name}" already exists (use update)` : `no shape "${name}"`); continue; }
    if (!validName(name)) { problems.push(`bad shape name "${name}" (letters, digits, - _; not starting with a digit)`); continue; }
    if (action === 'delete') { names.delete(name); changes.push({ action, name }); continue; }
    const base = existing.find((s) => s.id === name);
    const kind = (c.kind ?? base?.kind) as ShapeKind;
    if (!KINDS.includes(kind)) { problems.push(`${name}: kind must be one of ${KINDS.join(', ')}`); continue; }
    // sizes: named fields (missing ones keep the current value, or the default); an array in SIZES order is accepted too
    const keys = sizeKeys(kind);
    const cur = base && base.kind === kind ? base.size : SIZES[kind].map((f) => f.def);
    const size = Array.isArray(c.size) ? keys.map((_, i) => Number(c.size[i] ?? cur[i]))
      : keys.map((k, i) => Number(c.size?.[k] ?? cur[i]));
    const unknownKeys = c.size && !Array.isArray(c.size) ? Object.keys(c.size).filter((k) => !keys.includes(k)) : [];
    if (unknownKeys.length) problems.push(`${name}: ${kind} sizes are ${keys.join(', ')} (not ${unknownKeys.join(', ')})`);
    if (size.some((v) => !(v > 0))) problems.push(`${name}: sizes must be positive metres`);
    if (kind === 'tube' && size[1] >= size[0]) problems.push(`${name}: inner_radius must be less than outer_radius`);
    const v3 = (v: unknown, dflt: number[], what: string) => {
      if (v === undefined) return dflt;
      if (!Array.isArray(v) || v.length !== 3 || v.some((x) => !Number.isFinite(Number(x)))) { problems.push(`${name}: ${what} must be [x, y, z]`); return dflt; }
      return v.map(Number);
    };
    const color = c.color ?? base?.color ?? '#c8d0d9';
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) problems.push(`${name}: colour must be #rrggbb`);
    let array = c.array === null ? undefined : base?.array;
    if (noArray(c.array)) { if (c.array === null || Object.keys(c.array).length) array = undefined; }   // {} = no change
    else if (c.array) {
      const n = Math.round(Number(c.array.count));
      if (!(n >= 2 && n <= 500)) problems.push(`${name}: array count must be 2..500`);
      if (c.array.type === 'linear') array = { type: 'linear', count: n, step: v3(c.array.step, [1, 0, 0], 'array step') };
      else if (c.array.type === 'circular') {
        const ce = c.array.centre ?? [0, 0];
        if (!Array.isArray(ce) || ce.length !== 2) problems.push(`${name}: circular array centre is [x, z]`);
        array = { type: 'circular', count: n, centre: (Array.isArray(ce) ? ce : [0, 0]).map(Number), angle: Number(c.array.angle ?? 360) };
      } else problems.push(`${name}: array.type is "linear" or "circular" (leave array out for a single one)`);
    }
    let rename: string | undefined;
    if (action === 'update' && c.rename && c.rename !== name) {
      rename = String(c.rename).trim();
      if (!validName(rename) || names.has(rename)) problems.push(`can't rename ${name} to "${rename}"`);
      else { names.delete(name); names.add(rename); }
    }
    if (action === 'create') names.add(name);
    const def: ShapeDef = { id: rename ?? name, kind, size: size.map((v) => +v.toFixed(6)), position: v3(c.position, base?.position ?? [0, 0, 0], 'position'),
      rotation: v3(c.rotation, base?.rotation ?? [0, 0, 0], 'rotation'), color, ...(array ? { array } : {}) };
    changes.push({ action, name, rename, def });
  }
  return { changes, problems };
}

export function modelProposeTools(d: ModelProposeDeps): AssistTool[] {
  return [
    ...(d.planPlacement ? [{
      name: 'propose_placement',
      description: 'Propose positioning parts in the model (their start pose for the whole animation – like dragging them with the gizmo at t = 0; the script is untouched). Each change moves the targets (ids, globs, short names or @groups) together as one rigid set: move_by [dx,dy,dz], or move_to [x,y,z] = where the anchor of their bounding box goes (anchor centre (default), bottom = bottom-centre, top = top-centre; e.g. to stand A on B: move_to B\'s top-centre with anchor bottom). rotate {axis x|y|z or [x,y,z], degrees, pivot (default the box centre)} is applied before the move. reset: true puts the parts back where the CAD has them. Locked parts can be placed (locking only stops animation). Shapes write their own position/rotation. Read positions with get_part first; the card shows the box before and after.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            targets: { type: 'array', items: { type: 'string' } },
            move_by: { ...vec3 },
            move_to: { ...vec3 },
            anchor: { type: 'string', enum: ['centre', 'bottom', 'top'] },
            rotate: { type: 'object', properties: { axis: { description: 'x, y, z or a vector [x,y,z]' }, degrees: { type: 'number' }, pivot: { ...vec3 } }, required: ['axis', 'degrees'] },
            reset: { type: 'boolean' },
          }, required: ['targets'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'placement',
      validate: (i: any) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i: any) {
        const changes = (i.changes as PlacementInput[]).map((c) => d.planPlacement!(c));
        const problems = changes.flatMap((c) => c.problems);
        const ok = !problems.length;
        const n = changes.reduce((a, c) => a + c.ids.length, 0);
        const label = ok ? `✓ ${n} part${n === 1 ? '' : 's'}` : `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'placement', summary: i.summary, check: { ok, label }, changes, problems } as AssistEvent;
        const f = (v?: number[]) => (v ? `[${v.map((x) => x.toFixed(3)).join(', ')}]` : '');
        return { content: ok ? `Proposed; waiting for the user.\n${changes.map((c) => `${c.targets.join(', ')}: ${c.reset ? 'reset' : `box centre ${f(c.before?.centre)} → ${f(c.after?.centre)}, min ${f(c.after?.min)}, max ${f(c.after?.max)}`}`).join('\n')}`
          : `Problems:\n${problems.join('\n')}\nFix them and propose again.` };
      },
    } satisfies AssistTool] : []),
    ...(d.shapes ? [{
      name: 'propose_shapes',
      description: `Propose making, changing or deleting shapes – simple solids the user models in the studio (they appear under Shapes in the tree and are parts the script can animate by name; they start unlocked). Kinds and their sizes (metres): ${SIZE_DOC}. Every shape is centred on its position, its axis along Y (upright): a cylinder/tube/cone/hex of height h standing on a surface at height y has position y + h/2; rotate it [90,0,0] to lie along Z or [0,0,90] to lie along X. Rotation is degrees about X, Y, Z. Optional array: linear {count, step [x,y,z]} or circular {count, centre [x,z], angle (360 = evenly round)}; copies are named <name>-0, <name>-1… For update, give only what changes (rename to change the name – the script follows); array null removes it. A shape exists only once the user accepts the card.`,
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            action: { type: 'string', enum: ['create', 'update', 'delete'] },
            name: { type: 'string', description: 'Shape name (letters, digits, - _), e.g. pipe' },
            kind: { type: 'string', enum: KINDS },
            size: { type: 'object', description: `Named sizes in metres for the kind: ${SIZE_DOC}`, additionalProperties: { type: 'number' } },
            position: { ...vec3, description: 'Centre [x, y, z] in metres' },
            rotation: { ...vec3, description: 'Degrees about X, Y, Z' },
            color: { type: 'string', description: '#rrggbb' },
            array: ARRAY_SCHEMA,
            rename: { type: 'string' },
          }, required: ['action', 'name'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'shapes',
      validate: (i: any) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i: any) {
        const { changes, problems } = shapeChanges(i.changes, d.shapes!());
        const ok = !problems.length;
        const label = ok ? `✓ ${changes.length} shape${changes.length > 1 ? 's' : ''}` : `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'shapes', summary: i.summary, check: { ok, label }, changes, problems } as AssistEvent;
        return { content: ok ? `Proposed (${label}); waiting for the user. Once accepted, each shape is a part named as given (array copies <name>-0…), unlocked.` : `Problems:\n${problems.join('\n')}\nFix them and propose again.` };
      },
    } satisfies AssistTool] : []),
    ...(d.copies && d.sourcesCentre ? [{
      name: 'propose_copies',
      description: 'Propose linked copies: duplicates of parts, assemblies or @groups ("of": ids, names, globs, @groups) that share and follow the source geometry (re-importing the CAD updates them; removing a source part removes it from its copies). A copy is placed by its centre: position [x,y,z] = where the centre of the sources\' bounding box goes, or offset [dx,dy,dz] from where the sources are. rotation: degrees about X, Y, Z about that centre. mirror: x, y or z (through the centre). array: linear {count, step [x,y,z] m} or circular {count, centre [x,z] of a vertical axis, angle (360 = evenly round)} – members are <name>-0, <name>-1… For update give only what changes (rename to change the name – the script follows; array/mirror null removes). Scripts use the copy\'s name (array members by <name>-<i>); parts inside need full ids copies/<name>/<source id>. Exists once accepted.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            action: { type: 'string', enum: ['create', 'update', 'delete'] },
            name: { type: 'string', description: 'Copy name (letters, digits, - _), e.g. pump-2' },
            of: { type: 'array', items: { type: 'string' } },
            position: { ...vec3, description: 'Where the copy\'s centre goes [x, y, z] m' },
            offset: { ...vec3, description: 'Or: how far from the sources [dx, dy, dz] m' },
            rotation: { ...vec3, description: 'Degrees about X, Y, Z' },
            mirror: { type: ['string', 'null'], enum: ['x', 'y', 'z', null] },
            array: ARRAY_SCHEMA,
            rename: { type: 'string' },
          }, required: ['action', 'name'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'copies',
      validate: (i: any) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i: any) {
        const { changes, problems } = copyChanges(i.changes, d);
        const ok = !problems.length;
        if (ok) for (const c of changes) if (c.def) proposedCopies.add(c.def.id);
        const label = ok ? `✓ ${changes.length} cop${changes.length > 1 ? 'ies' : 'y'}` : `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'copies', summary: i.summary, check: { ok, label }, changes, problems } as AssistEvent;
        return { content: ok ? `Proposed (${label}); waiting for the user.\n${changes.filter((c) => c.def).map((c) => `${c.def!.id}: sources' centre [${c.centre}] → [${c.def!.position}]`).join('\n')}` : `Problems:\n${problems.join('\n')}\nFix them and propose again.` };
      },
    } satisfies AssistTool] : []),
    ...(d.annotations && d.annotationTarget ? [{
      name: 'get_annotations',
      description: 'List the annotations (title + note about parts, a @group or a folder, with a leader to a point): id, title, note, target, the part ids it covers now, the leader point [x,y,z] and whether it is shown. Optional filter: text matched against title / note / target / part ids.',
      input_schema: { type: 'object', properties: { filter: { type: 'string' } } },
      async *run(i: any) {
        const f = String(i.filter ?? '').toLowerCase();
        const list = d.annotations!().filter((a) => !f || [a.title, a.note, a.target, ...a.parts].some((x) => x.toLowerCase().includes(f)));
        const r2a = (v: number[] | null) => (v ? `[${v.map((x) => +x.toFixed(2)).join(', ')}]` : 'centre');
        return { content: list.length ? list.map((a) => `${a.id}: "${a.title}"${a.show ? '' : ' (hidden)'} – ${a.target} (${a.parts.length} part${a.parts.length === 1 ? '' : 's'}${a.parts.length <= 5 ? `: ${a.parts.join(', ')}` : ''}) at ${r2a(a.point)}${a.note ? `\n  ${a.note.replace(/\n/g, '\n  ')}` : ''}`).join('\n') : (f ? `No annotations match "${i.filter}".` : 'No annotations yet.') };
      },
    } satisfies AssistTool, {
      name: 'propose_annotations',
      description: 'Propose annotations: a title and a note about parts (ids, names, globs), a @group, a list, or a folder ("folder:Path/Sub"), shown in the view as a card with a leader. create {title, note, target, point?} – point [x,y,z] is where the leader points (on the target; default its centre; read boxes with get_part). A target may be a copy proposed earlier in this conversation (\"copies/<name>\"; one annotation on an array copy covers all its members) – propose the copies and their annotations in the same turn; the annotations attach once the copies card is accepted (leave point out for those); update {id, title?, note?, target?, point?, show?}; delete {id}. Ids come from get_annotations. Each becomes a card the user accepts.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            action: { type: 'string', enum: ['create', 'update', 'delete'] },
            id: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' }, target: { type: 'string' },
            point: { ...vec3, description: 'World [x, y, z] m for the leader tip' }, show: { type: 'boolean' },
          }, required: ['action'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'annotations',
      validate: (i: any) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i: any) {
        const { changes, problems } = annotationChanges(i.changes, d);
        const ok = !problems.length;
        const label = ok ? `✓ ${changes.length} annotation${changes.length > 1 ? 's' : ''}` : `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'annotations', summary: i.summary, check: { ok, label }, changes, problems } as AssistEvent;
        return { content: ok ? `Proposed (${label}); waiting for the user.` : `Problems:\n${problems.join('\n')}\nFix them and propose again.` };
      },
    } satisfies AssistTool] : []),
    {
      name: 'propose_groups',
      description: 'Propose changes to user groups (named sets of parts, used in scripts as @name). Actions: create (new group with parts), add / remove (parts to/from an existing group), delete (the group only – parts are unaffected). Parts are ids, globs with *, or other @groups. The user accepts or rejects.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            action: { type: 'string', enum: ['create', 'add', 'remove', 'delete'] },
            name: { type: 'string', description: 'Group name without @ (letters, digits, - _)' },
            parts: { type: 'array', items: { type: 'string' } },
          }, required: ['action', 'name'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'group changes',
      validate: (i) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i) {
        const groups = d.groups();
        const problems: string[] = [];
        const changes = i.changes.map((c: any) => {
          const name = String(c.name ?? '').replace(/^@/, '');
          if (!/^[\w.-]+$/.test(name)) problems.push(`bad group name "${c.name}"`);
          if (!['create', 'add', 'remove', 'delete'].includes(c.action)) problems.push(`unknown action "${c.action}"`);
          if ((c.action === 'add' || c.action === 'remove' || c.action === 'delete') && !groups[name]) problems.push(`group @${name} does not exist`);
          if (c.action === 'create' && groups[name]) problems.push(`group @${name} already exists (use add)`);
          const r = c.action === 'delete' ? { ids: [], unknown: [] } : d.resolve(c.parts ?? []);
          if (c.action !== 'delete' && !r.ids.length) problems.push(`@${name}: no parts matched`);
          r.unknown.forEach((u) => problems.push(`unknown part "${u}"`));
          return { action: c.action, name, ids: r.ids };
        });
        const ok = !problems.length;
        const label = ok ? `✓ ${changes.length} change${changes.length > 1 ? 's' : ''}` : `${problems.length} problem${problems.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', kind: 'groups', summary: i.summary, check: { ok, label }, changes, problems };
        return { content: ok ? `Proposed (${label}); waiting for the user.` : `Proposed with problems:\n${problems.join('\n')}\nFix them and propose again.` };
      },
    },
    {
      name: 'propose_state',
      description: 'Propose lock/unlock, hide/show, base-colour and keep-uncut (left whole by every cutaway) changes for parts (ids, globs or @groups). Parts must be unlocked before a script can animate them; hidden + locked CAD parts are unloaded from memory. Changes go into the working snapshot (unsaved until the user saves). The user accepts or rejects.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          changes: { type: 'array', items: { type: 'object', properties: {
            targets: { type: 'array', items: { type: 'string' } },
            lock: { type: 'boolean', description: 'true = lock, false = unlock' },
            hide: { type: 'boolean', description: 'true = hide, false = show' },
            remove: { type: 'boolean', description: 'true = remove from this animation\'s assembly (hidden, unloaded; the CAD file is untouched), false = restore' },
            color: { type: ['string', 'null'], description: 'Base colour #rrggbb to show the parts in (null = back to their own colour). Use colour to clarify / highlight components.' },
            keep_uncut: { type: 'boolean', description: 'true = every cutaway leaves these parts whole (the animation\'s keep-uncut list), false = cut them again' },
          }, required: ['targets'] } },
        },
        required: ['summary', 'changes'],
      },
      writing: 'state changes',
      validate: (i) => check(i, { summary: 'string' }) ?? (Array.isArray(i.changes) && i.changes.length ? undefined : '"changes" must be a non-empty array'),
      async *run(i) {
        const problems: string[] = [];
        const changes = i.changes.map((c: any) => {
          const r = d.resolve(c.targets ?? []);
          r.unknown.forEach((u) => problems.push(`unknown target "${u}"`));
          if (c.lock === undefined && c.hide === undefined && c.color === undefined && c.remove === undefined && c.keep_uncut === undefined) problems.push('a change needs lock, hide, color, remove and/or keep_uncut');
          if (c.color && !/^#[0-9a-fA-F]{6}$/.test(c.color)) problems.push(`colour must be #rrggbb, not ${c.color}`);
          return { targets: c.targets, ids: r.ids, lock: c.lock, hide: c.hide, color: c.color, remove: c.remove, keep_uncut: c.keep_uncut };
        });
        const ok = !problems.length;
        const n = changes.reduce((a: number, c: any) => a + c.ids.length, 0);
        yield { type: 'proposal', kind: 'state', summary: i.summary, check: { ok, label: ok ? `✓ ${n} part${n === 1 ? '' : 's'}` : `${problems.length} problem(s)` }, changes, problems };
        return { content: ok ? `Proposed (${n} parts); waiting for the user.` : `Problems:\n${problems.join('\n')}` };
      },
    },
  ];
}

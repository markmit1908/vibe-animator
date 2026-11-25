/**
 * Read-only assist tools: browse/search the assembly, inspect parts, check a draft script,
 * and look at the scene (screenshot). They run in the browser against the live scene.
 */
import * as THREE from 'three';
import type { AssistTool, ToolResult } from './loop';

export interface ToolDeps {
  registry: Map<string, THREE.Object3D>;
  groups: () => Record<string, string[]>;
  isLocked: (o: THREE.Object3D) => boolean;
  isHidden: (o: THREE.Object3D) => boolean;
  /** Parse + compile a draft script without changing anything. */
  checkScript: (text: string) => { errors: { line: number; message: string }[]; duration?: number; steps?: { line: number; start: number; end: number; text: string }[] };
  /** Render a view to a JPEG (base64), optionally framing a target. */
  screenshot: (view: string, target?: string) => { data: string; width: number; height: number; note: string };
  /** Top-level roots of the assembly (CAD model wrappers / generated parts). */
  roots: () => THREE.Object3D[];
}

const idOf = (o: THREE.Object3D) => (o.userData.id ?? o.name) as string;
const r2 = (n: number) => +n.toFixed(2);
const v3 = (v: THREE.Vector3) => `[${r2(v.x)}, ${r2(v.y)}, ${r2(v.z)}]`;
const box = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o);
const kids = (o: THREE.Object3D) => o.children.filter((c) => c.userData.id || c.userData.kind === 'block');

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
          const name = (o.name || '').toLowerCase(), lid = id.toLowerCase();
          if (re ? !(re.test(lid) || re.test(name)) : !(lid.includes(q) || name.includes(q))) continue;
          total++;
          if (hits.length < lim) hits.push(`${id} | ${o.name || '-'} | ${kids(o).length} children | ${flags(o, d)} | size ${v3(box(o).getSize(new THREE.Vector3()))} m`);
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
      description: 'Parse and compile a complete draft .anim script without applying it. Returns errors (line: message) or the duration and each step\'s start–end time. Use it before proposing script changes.',
      input_schema: { type: 'object', properties: { text: { type: 'string', description: 'The whole script' } }, required: ['text'] },
      writing: 'a draft script',
      validate: (i) => check(i, { text: 'string' }),
      async *run(i) {
        yield { type: 'tool', name: 'check_script', label: 'checked a draft script' };
        const r = d.checkScript(i.text);
        if (r.errors.length) return { content: `${r.errors.length} error(s):\n${r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}` };
        return { content: `OK – duration ${r.duration?.toFixed(1)} s\n${(r.steps ?? []).map((s) => `line ${s.line} [${s.start.toFixed(1)}–${s.end.toFixed(1)}s] ${s.text}`).join('\n')}` };
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
      description: 'Propose a new version of the whole .anim script. The user sees a diff with a compile check and can preview, accept or reject it. Send the COMPLETE script text (not a fragment), keeping lines you are not changing exactly as they are. Run check_script first and only propose a script that compiles.',
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
      async *run(i) {
        const base = d.currentScript();
        const text = i.text.endsWith('\n') ? i.text : `${i.text}\n`;
        if (text === base) return { content: 'That is identical to the current script – nothing to propose.', is_error: true };
        const r = d.checkScript(text);
        const ok = r.errors.length === 0;
        const label = ok ? `✓ compiles · ${r.duration?.toFixed(1)} s` : `${r.errors.length} error${r.errors.length > 1 ? 's' : ''}`;
        yield { type: 'proposal', proposal: { kind: 'script edit', summary: i.summary, check: { ok, label }, base, text, errors: r.errors } };
        return {
          content: ok
            ? `Proposed (${label}). The user will preview/accept or reject it; don't repeat the script in your reply – summarise the change in a sentence or two.`
            : `Proposed, but it does not compile:\n${r.errors.map((e) => `line ${e.line}: ${e.message}`).join('\n')}\nFix it with check_script and propose again.`,
        };
      },
    },
  ];
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

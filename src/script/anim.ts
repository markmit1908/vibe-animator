/**
 * `.anim` animation script: one step per line, `parallel { … }` blocks run together.
 *
 *   camera [12,16,14] look [0,5,0] 3s
 *   camera overview 2s                 (a view saved with the Views tool)
 *   label "Remove lid" "Unbolt and lift"
 *   move @lid by [0,3,0] 6s ease
 *   move part-a, part-b, @lid by [0,3,0] 6s       # several targets
 *   move plant/…/V-005738 to [0,5,0] 4s
 *   rotate @lid by [0,0,90] about [0,12,0] 4s      # degrees, world axes
 *   pivot @lid [0,12,0]                            # pivot travels with @lid
 *   hide @shielding 1s     show @shielding     fade @bolts to 0.2 2s
 *   highlight @spent #c0392b 1s                    # or palette name
 *   color @lid #2e86de 1s · color @lid reset 1s    # change colour / back to its base colour
 *   cutaway quarter        wait 2s
 *   list @layer3 = F1-*-3                       # a list: names, globs, @groups
 *   each @layer3 stagger 0.2s order ring {      # loop: $ = item, $i = index; item i starts at i × stagger
 *     move $ by [0, 1 + $i*0.05, 0] 1s
 *     fade $ to 0 0.5s
 *   }
 *   parallel {
 *     move @lid by [4,0,0] 5s
 *     camera [8,14,6] look [2,10,0] 5s
 *   }
 *
 * The parser keeps source positions so the editor can mark errors, show step times
 * and write edits back into the text.
 */

export type Vec = [number, number, number];
export type Ease = 'ease' | 'linear' | 'in' | 'out';

export interface Arg<T> { value: T; from: number; to: number }

export interface AnimStep {
  verb: string;
  line: number;            // 1-based
  from: number; to: number; // char range of the line's content (no comment)
  target?: Arg<string>;
  mode?: Arg<'by' | 'to'>;
  vec?: Arg<Vec>;
  about?: Arg<Vec>;
  look?: Arg<Vec>;
  num?: Arg<number>;
  text?: Arg<string>[];
  word?: Arg<string>;
  dur?: Arg<number>;
  ease?: Arg<Ease>;
  children?: AnimStep[];    // parallel / each block
  stagger?: Arg<number>;    // each: start of item i+1 after item i's start
  items?: Arg<string>;      // list: the items text
  endLine?: number;         // closing brace line of a block
}

export interface ParseError { line: number; from: number; to: number; message: string; fix?: { label: string; run: () => void } }
export interface AnimDoc { steps: AnimStep[]; errors: ParseError[] }

const VERBS = ['list', 'each', 'move', 'rotate', 'hide', 'show', 'fade', 'highlight', 'color', 'label', 'camera', 'cutaway', 'wait', 'pivot', 'parallel'];
export const ANIM_VERBS = VERBS;

interface Tok { t: 'word' | 'str' | 'vec' | 'num' | 'dur' | 'color' | 'brace'; v: any; from: number; to: number }

function lex(src: string, base: number, line: number, errors: ParseError[]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const err = (from: number, to: number, message: string) => errors.push({ line, from: base + from, to: base + to, message });
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const s = i;
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      if (j < 0) { err(i, src.length, 'Unclosed string'); return out; }
      out.push({ t: 'str', v: src.slice(i + 1, j), from: base + s, to: base + j + 1 }); i = j + 1; continue;
    }
    if (c === '[') {
      const j = src.indexOf(']', i);
      if (j < 0) { err(i, src.length, 'Unclosed [ ]'); return out; }
      const parts = src.slice(i + 1, j).split(',').map((p) => p.trim());
      // a component is a number, or an expression over $i (the loop index), e.g. 1 + $i*0.1
      const vals = parts.map((p) => (Number.isFinite(Number(p)) && p !== '' ? Number(p) : /^[\d\s.+\-*/()$i]+$/.test(p) && p.includes('$i') ? `{${p}}` : NaN));
      if (parts.length !== 3 || vals.some((n) => typeof n === 'number' && !Number.isFinite(n))) err(i, j + 1, 'Expected [x, y, z] (three numbers; inside each: expressions with $i)');
      out.push({ t: 'vec', v: vals as unknown as Vec, from: base + s, to: base + j + 1 }); i = j + 1; continue;
    }
    if (c === '{' || c === '}') { out.push({ t: 'brace', v: c, from: base + i, to: base + i + 1 }); i++; continue; }
    let j = i;
    while (j < src.length && !/[\s[\]{}"]/.test(src[j])) j++;
    const w = src.slice(i, j);
    const m = w.match(/^(-?\d*\.?\d+)(ms|s)$/);
    if (m) out.push({ t: 'dur', v: Number(m[1]) / (m[2] === 'ms' ? 1000 : 1), from: base + s, to: base + j });
    else if (/^-?\d*\.?\d+$/.test(w)) out.push({ t: 'num', v: Number(w), from: base + s, to: base + j });
    else if (/^#[0-9a-fA-F]{3,8}$/.test(w)) out.push({ t: 'color', v: w, from: base + s, to: base + j });
    else out.push({ t: 'word', v: w, from: base + s, to: base + j });
    i = j;
  }
  return out;
}

export function parseAnim(text: string): AnimDoc {
  const errors: ParseError[] = [];
  const root: AnimStep[] = [];
  const stack: AnimStep[] = [];
  let offset = 0;
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const base = offset;
    offset += raw.length + 1;
    const hash = raw.search(/#(?![0-9a-fA-F]{3,8}\b)/); // '#' comment, but not a #hex colour
    const content = hash >= 0 ? raw.slice(0, hash) : raw;
    const toks = lex(content, base, lineNo, errors);
    if (!toks.length) return;
    const err = (from: number, to: number, message: string) => errors.push({ line: lineNo, from, to, message });
    const into = () => (stack.length ? stack[stack.length - 1].children! : root);

    if (toks[0].t === 'brace' && toks[0].v === '}') {
      const b = stack.pop();
      if (!b) err(toks[0].from, toks[0].to, 'Unmatched }');
      else b.endLine = lineNo;
      return;
    }
    if (toks[0].t !== 'word' || !VERBS.includes(toks[0].v)) {
      err(toks[0].from, toks[0].to, `Unknown step "${toks[0].v}". Use: ${VERBS.join(', ')}`);
      return;
    }
    const step: AnimStep = { verb: toks[0].v, line: lineNo, from: toks[0].from, to: toks[toks.length - 1].to };
    let k = 1;
    const peek = () => toks[k];
    const take = <T extends Tok['t']>(t: T, what: string): Tok | undefined => {
      const x = toks[k];
      if (!x || x.t !== t) { const at = x ?? toks[toks.length - 1]; err(at.from, at.to, `Expected ${what}`); return; }
      k++; return x;
    };
    const arg = <T>(x: Tok | undefined): Arg<T> | undefined => x && { value: x.v, from: x.from, to: x.to };
    const target = () => {
      const x = toks[k];
      if (!x || x.t !== 'word') { err((x ?? toks[0]).from, (x ?? toks[0]).to, 'Expected a target (@group or part id)'); return; }
      k++;
      // several targets: "a, b, @g" (commas may be followed by spaces, which split the words)
      let to = x.to, text = x.v as string;
      while (text.endsWith(',') && toks[k]?.t === 'word') { text += toks[k].v; to = toks[k].to; k++; }
      step.target = { value: text.replace(/,+$/, ''), from: x.from, to };
    };
    // trailing options: duration, easing
    const tail = () => {
      while (k < toks.length) {
        const x = toks[k];
        if (x.t === 'dur') step.dur = arg(x);
        else if (x.t === 'num' && step.verb === 'wait') step.dur = arg(x);
        else if (x.t === 'word' && ['ease', 'linear', 'in', 'out'].includes(x.v)) step.ease = arg(x);
        else if (x.t === 'word' && x.v === 'about' && step.verb === 'rotate') { k++; step.about = arg(take('vec', '[x, y, z] pivot after "about"')); continue; }
        else { err(x.from, x.to, `Unexpected "${String(x.v)}"`); }
        k++;
      }
    };
    const mode = () => {
      const x = peek();
      if (x?.t === 'word' && (x.v === 'by' || x.v === 'to')) { k++; step.mode = arg(x); }
      else step.mode = { value: 'by', from: step.to, to: step.to }; // default relative
      step.vec = arg(take('vec', '[x, y, z]'));
    };

    switch (step.verb) {
      case 'move': case 'rotate': target(); mode(); tail(); break;
      case 'pivot': target(); step.vec = arg(take('vec', '[x, y, z] pivot point')); tail(); break;
      case 'hide': case 'show': target(); tail(); break;
      case 'fade': {
        target();
        if (peek()?.t === 'word' && peek()!.v === 'to') k++;
        step.num = arg(take('num', 'opacity 0..1'));
        tail(); break;
      }
      case 'highlight': case 'color': {
        target();
        const x = peek();
        if (x && (x.t === 'color' || x.t === 'word')) { k++; step.word = arg(x); }
        tail(); break;
      }
      case 'label': {
        step.text = [];
        while (peek()?.t === 'str') step.text.push(arg(toks[k++])!);
        if (!step.text.length) err(step.from, step.to, 'Expected "title" ["subtitle"]');
        tail(); break;
      }
      case 'camera': {
        if (peek()?.t === 'word' && !/^\d/.test(peek()!.v)) { step.word = arg(toks[k++]); tail(); break; } // a saved view: camera <name> 2s
        step.vec = arg(take('vec', 'camera position [x, y, z]'));
        if (peek()?.t === 'word' && peek()!.v === 'look') { k++; step.look = arg(take('vec', 'look-at point [x, y, z]')); }
        tail(); break;
      }
      case 'cutaway': {
        const x = take('word', 'none | half | quarter');
        if (x && !['none', 'half', 'quarter'].includes(x.v)) err(x.from, x.to, 'Expected none | half | quarter');
        step.word = arg(x); tail(); break;
      }
      case 'wait': tail(); if (!step.dur) err(step.from, step.to, 'Expected a duration, e.g. wait 2s'); break;
      case 'list': {
        // list @name = a, b, F1-*-3, @group   (any spacing around "=" and ",")
        const rest = toks.slice(1);
        const joined = rest.map((x) => String(x.v)).join(' ');
        const m = joined.match(/^(@[\w.-]+)\s*=\s*(.*)$/);
        if (!m) { err((rest[0] ?? toks[0]).from, step.to, 'Expected: list @name = item, item, …'); k = toks.length; break; }
        step.target = { value: m[1], from: rest[0].from, to: rest[0].from + m[1].length };
        if (!m[2].trim()) err(step.from, step.to, 'Expected the list items after "="');
        step.items = { value: m[2].replace(/\s*,\s*/g, ', ').trim(), from: rest[0].from, to: step.to };
        k = toks.length;
        break;
      }
      case 'each': {
        // each TARGET [stagger 0.2s] [order x|-x|y|-y|z|-z|ring|-ring|random] {
        target();
        while (k < toks.length && !(toks[k].t === 'brace')) {
          const x = toks[k];
          if (x.t === 'word' && x.v === 'stagger') { k++; const d = toks[k]; if (d && (d.t === 'dur' || d.t === 'num')) { step.stagger = { value: d.v, from: d.from, to: d.to }; k++; } else err(x.from, x.to, 'Expected a time after stagger, e.g. stagger 0.2s'); continue; }
          if (x.t === 'word' && x.v === 'order') { k++; const o = toks[k]; if (o?.t === 'word' && /^-?(x|y|z|ring)$|^random$/.test(o.v)) { step.word = arg(o); k++; } else err((o ?? x).from, (o ?? x).to, 'order is x, -x, y, -y, z, -z, ring, -ring or random'); continue; }
          err(x.from, x.to, `Unexpected "${String(x.v)}" (each TARGET [stagger 0.2s] [order …] {)`); k++;
        }
        if (peek()?.t === 'brace' && peek()!.v === '{') k++; else err(step.from, step.to, 'Expected "{" to open the loop');
        step.children = [];
        into().push(step);
        stack.push(step);
        return;
      }
      case 'parallel': {
        if (peek()?.t === 'brace' && peek()!.v === '{') k++;
        else err(step.from, step.to, 'Expected "parallel {"');
        step.children = [];
        into().push(step);
        stack.push(step);
        if (k < toks.length) err(toks[k].from, toks[k].to, 'Put each parallel step on its own line');
        return;
      }
    }
    into().push(step);
  });
  for (const b of stack) errors.push({ line: b.line, from: b.from, to: b.to, message: `${b.verb} { … } is not closed` });
  return { steps: root, errors };
}

/** Steps → the timeline engine's action objects (each carries `line` for step timing / errors). */
export function toActions(steps: AnimStep[]): { camera?: any; timeline: any[] } {
  let camera: any;
  const conv = (s: AnimStep): any => {
    const base: any = { line: s.line };
    if (s.dur) base.dur = s.dur.value;
    if (s.ease) base.ease = s.ease.value;
    // several comma-separated targets become a list (the compiler resolves each)
    const tgt = s.target?.value?.includes(',') ? s.target.value.split(',').map((x) => x.trim()).filter(Boolean) : s.target?.value;
    switch (s.verb) {
      case 'move': return { ...base, move: tgt, [s.mode!.value]: s.vec!.value, dur: s.dur?.value ?? 0 };
      case 'rotate': return { ...base, rotate: tgt, [s.mode!.value]: s.vec!.value, about: s.about?.value, dur: s.dur?.value ?? 0 };
      case 'pivot': return { ...base, pivot: tgt, point: s.vec!.value };
      case 'hide': return { ...base, fade: tgt, to: 0, dur: s.dur?.value ?? 0 };
      case 'show': return { ...base, fade: tgt, to: 1, dur: s.dur?.value ?? 0 };
      case 'fade': return { ...base, fade: tgt, to: s.num!.value, dur: s.dur?.value ?? 1 };
      case 'highlight': return { ...base, highlight: tgt, color: s.word?.value ?? 'spent' };
      case 'color': return { ...base, highlight: tgt, color: s.word?.value ?? 'reset', dur: s.dur?.value ?? 0 };
      case 'label': return { ...base, label: s.text![0]?.value, sub: s.text![1]?.value };
      case 'camera': return { ...base, camera: s.word ? { view: s.word.value } : { pos: s.vec!.value, look: s.look?.value }, dur: s.dur?.value ?? 0 };
      case 'cutaway': return { ...base, cutaway: s.word!.value };
      case 'wait': return { ...base, wait: s.dur!.value };
      case 'parallel': return { ...base, parallel: s.children!.map((c) => [conv(c)]) };
      case 'list': return { ...base, list: tgt, items: (s.items?.value ?? '').split(',').map((x) => x.trim()).filter(Boolean) };
      case 'each': return { ...base, each: tgt, stagger: s.stagger?.value, order: s.word?.value, steps: s.children!.map(conv) };
    }
  };
  const timeline = steps.map(conv);
  // a leading instant camera sets the initial view
  if (timeline[0]?.camera && !timeline[0].dur) camera = timeline[0].camera.view ? { view: timeline[0].camera.view, line: timeline[0].line } : { pos: timeline[0].camera.pos, look: timeline[0].camera.look ?? [0, 0, 0] };
  return { camera, timeline };
}

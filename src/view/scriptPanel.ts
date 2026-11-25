/**
 * Script panel (right column, under the playback controls): CodeMirror 6 editor for `.anim` scripts.
 * Patterns follow SolverKit's ModelText: the text is canonical, diagnostics are lint marks,
 * completion is context-aware, and app-side edits are applied as minimal changes.
 */
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, GutterMarker, gutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { ANIM_VERBS, type ParseError } from '../script/anim';
import type { LineTiming } from '../timeline/compile';

// ---------- syntax highlighting ----------
const animLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^#[0-9a-fA-F]{3,8}\b/)) return 'atom';
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (stream.match(/^-?\d*\.?\d+(ms|s)\b/)) return 'unit';
    if (stream.match(/^-?\d*\.?\d+/)) return 'number';
    if (stream.match(/^@[\w.-]+/)) return 'variableName.special';
    if (stream.match(/^[[\]{},]/)) return 'bracket';
    const w = stream.match(/^[^\s[\]{}",]+/) as RegExpMatchArray | null;
    if (!w) { stream.next(); return null; }
    if (stream.column() === stream.indentation() || ANIM_VERBS.includes(w[0]) && stream.string.slice(0, stream.start).trim() === '') return 'keyword';
    if (['by', 'to', 'about', 'look', 'stagger', 'order', '='].includes(w[0])) return 'operator';
    if (w[0] === '$' || w[0] === '$i' || w[0].startsWith('$')) return 'variableName.special';
    if (['ease', 'linear', 'in', 'out', 'none', 'half', 'quarter', 'reset'].includes(w[0])) return 'atom';
    return 'variableName';
  },
  languageData: { commentTokens: { line: '#' } },
});
const hl = HighlightStyle.define([
  { tag: tags.keyword, color: '#f2b705', fontWeight: '600' },
  { tag: tags.operator, color: '#c792ea' },
  { tag: tags.comment, color: '#5b6670', fontStyle: 'italic' },
  { tag: tags.string, color: '#a5d6a7' },
  { tag: [tags.number, tags.unit], color: '#82aaff' },
  { tag: tags.special(tags.variableName), color: '#ff8c1a' },
  { tag: tags.variableName, color: '#d7dde4' },
  { tag: tags.atom, color: '#89ddff' },
  { tag: tags.bracket, color: '#7b8794' },
]);

// ---------- step timing gutter + active-step highlight ----------
const setTimes = StateEffect.define<{ lines: Map<number, LineTiming>; active: Set<number> }>();
const timesField = StateField.define<{ lines: Map<number, LineTiming>; active: Set<number> }>({
  create: () => ({ lines: new Map(), active: new Set() }),
  update: (v, tr) => { for (const e of tr.effects) if (e.is(setTimes)) return e.value; return v; },
});
const activeDeco = EditorView.decorations.compute([timesField], (state) => {
  const { active } = state.field(timesField);
  const b = new RangeSetBuilder<Decoration>();
  for (const ln of [...active].sort((a, c) => a - c)) {
    if (ln > state.doc.lines) continue;
    const l = state.doc.line(ln);
    b.add(l.from, l.from, Decoration.line({ class: 'cm-activeStep' }));
  }
  return b.finish() as DecorationSet;
});

class TimeMarker extends GutterMarker {
  constructor(readonly t: LineTiming, readonly line: number, readonly panel: ScriptPanel) { super(); }
  eq(o: TimeMarker) { return o.t.start === this.t.start && o.t.end === this.t.end && o.line === this.line; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-stepTime';
    el.textContent = fmtT(this.t.start);
    el.title = `${fmtT(this.t.start)} → ${fmtT(this.t.end)}\nclick: run to end of step · drag ←→: scrub within step`;
    const dur = this.t.end - this.t.start;
    if (dur > 0) {
      const bar = document.createElement('span'); bar.className = 'cm-stepBar';
      el.appendChild(bar);
    }
    el.onmousedown = (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      let dragged = false;
      const move = (ev: MouseEvent) => {
        const dx = ev.clientX - x0;
        if (Math.abs(dx) > 3) dragged = true;
        if (dragged && dur > 0) this.panel.hooks.seek(this.t.start + Math.max(0, Math.min(1, dx / 120)) * dur);
      };
      const up = () => {
        removeEventListener('mousemove', move); removeEventListener('mouseup', up);
        if (!dragged) this.panel.hooks.seek(this.t.end);
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    };
    return el;
  }
}
const fmtT = (t: number) => (t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : `${t.toFixed(1)}s`);

export interface ScriptHooks {
  /** Text changed (debounced by the panel). */
  change(text: string): void;
  save(text: string): Promise<void>;
  seek(t: number): void;
  /** Completion candidates: part ids and @groups. */
  ids(): string[];
  /** `camera … look …` line for the current view. */
  cameraLine(): string;
}

const CSS = `
#script { flex: 1; min-height: 0; display: flex; flex-direction: column; color: #d7dde4; font: 12px system-ui, sans-serif; }
#script .bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #222a33; }
#script .bar b { flex: 1; font-size: 12px; }
#script .bar .dirty { color: #ff8c1a; font-size: 11px; }
#script .bar .ok { color: #46a758; font-size: 11px; }
#script .bar .pick { color: #f2b705; font-size: 11px; } #script .bar .err { color: #e5484d; font-size: 11px; }
#script button, #script select { background: #222a33; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 11px; }
#script .host { flex: 1; min-height: 0; overflow: auto; }
.cm-activeStep { background: rgba(242,183,5,.10) !important; }
.cm-stepTime { font: 10px ui-monospace, monospace; color: #7b8794; padding: 0 6px 0 4px; cursor: pointer; position: relative; min-width: 42px; }
.cm-stepTime:hover { color: #f2b705; }
.cm-stepBar { position: absolute; left: 4px; right: 6px; bottom: 1px; height: 2px; background: #2b3540; border-radius: 1px; }
`;

export class ScriptPanel {
  view: EditorView;
  el: HTMLElement;
  private status: HTMLElement;
  private dirtyEl: HTMLElement;
  private saved = '';
  private timer?: number;
  mode: 'by' | 'to' = 'by';
  /** Pick mode: the cursor is where a step's target goes – parts clicked in the tree / 3D view are inserted there. */
  private pick?: { from: number; to: number };
  private pickEl!: HTMLElement;
  /** Verbs whose next word is a target. */
  private static TARGETED = /^(\s*)(?:move|rotate|hide|show|fade|highlight|color|pivot|each|list\s+@[\w.-]+\s*=)\s+([^\s]*(?:,\s*[^\s]*)*)$/;

  constructor(public right: HTMLElement, public name: string, text: string, public hooks: ScriptHooks) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.id = 'script';
    this.el.innerHTML = `<div class="bar"><b>Script · ${name}</b><span class="status"></span><span class="dirty"></span><span class="pick" title="Click parts in the tree or the 3D view to insert them (⌘/Ctrl-click: add another). Esc: stop."></span>
      <select title="How edits made with the gizmo are written"><option value="by">edit: by</option><option value="to">edit: to</option></select>
      <button data-a="cam" title="Insert the current camera view after the cursor line">📷</button>
      <button data-a="run" title="Run to end of the cursor's step (⌘↵)">▶ here</button>
      <button data-a="save" title="Save (⌘S)">Save</button></div><div class="host"></div>`;
    right.appendChild(this.el);
    this.status = this.el.querySelector('.status')!;
    this.dirtyEl = this.el.querySelector('.dirty')!;
    this.pickEl = this.el.querySelector('.pick')!;
    const modeSel = this.el.querySelector('select')!;
    modeSel.onchange = () => (this.mode = modeSel.value as 'by' | 'to');
    this.el.querySelector<HTMLElement>('[data-a=save]')!.onclick = () => this.save();
    this.el.querySelector<HTMLElement>('[data-a=run]')!.onclick = () => this.runToCursor();
    this.el.querySelector<HTMLElement>('[data-a=cam]')!.onclick = () => {
      const l = this.view.state.doc.line(this.cursorLine);
      const ind = l.text.match(/^\s*/)![0];
      this.view.dispatch({ changes: { from: l.to, insert: `\n${ind}${this.hooks.cameraLine()}` }, selection: { anchor: l.to + 1 } });
    };
    this.saved = text;

    const complete = (cx: CompletionContext): CompletionResult | null => {
      const word = cx.matchBefore(/[@\w./#-]*/);
      if (!word || (word.from === word.to && !cx.explicit)) return null;
      const line = cx.state.doc.lineAt(cx.pos);
      const before = line.text.slice(0, cx.pos - line.from);
      if (/^\s*[\w]*$/.test(before)) {
        return { from: word.from, options: ANIM_VERBS.map((v) => ({ label: v, type: 'keyword' })) };
      }
      const opts = this.hooks.ids().map((id) => ({ label: id, type: id.startsWith('@') ? 'class' : 'variable' }));
      return { from: word.from, options: opts, validFor: /^[@\w./#-]*$/ };
    };

    this.view = new EditorView({
      parent: this.el.querySelector('.host')!,
      state: EditorState.create({
        doc: text,
        extensions: [
          timesField, activeDeco,
          gutter({
            class: 'cm-stepGutter',
            lineMarker: (view, line) => {
              const ln = view.state.doc.lineAt(line.from).number;
              const t = view.state.field(timesField).lines.get(ln);
              return t ? new TimeMarker(t, ln, this) : null;
            },
            lineMarkerChange: (u) => u.transactions.some((tr) => tr.effects.some((e) => e.is(setTimes))),
          }),
          lineNumbers(), history(), lintGutter(),
          animLang, syntaxHighlighting(hl),
          autocompletion({ override: [complete] }),
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { this.save(); return true; } },
            { key: 'Mod-Enter', preventDefault: true, run: () => { this.runToCursor(); return true; } },
            { key: 'Escape', run: () => { if (!this.pick) return false; this.pick = undefined; this.pickEl.textContent = ''; return true; } },
            ...defaultKeymap, ...historyKeymap, indentWithTab,
          ]),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '12.5px', height: '100%', backgroundColor: 'transparent', color: '#d7dde4' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', caretColor: '#f2b705' },
            '.cm-gutters': { backgroundColor: 'transparent', color: '#5b6670', borderRight: '1px solid #222a33' },
            '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.03)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-tooltip': { backgroundColor: '#14191f', border: '1px solid #2b3540', color: '#d7dde4' },
          }, { dark: true }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) this.updatePick(u.state);
            if (!u.docChanged) return;
            this.updateDirty();
            clearTimeout(this.timer);
            this.timer = window.setTimeout(() => this.hooks.change(this.text), 250);
          }),
        ],
      }),
    });
    this.updateDirty();
  }

  /** Shut down: no pending autosave may fire after the studio is replaced. */
  destroy() { clearTimeout(this.timer); this.timer = undefined; this.view.destroy(); }

  get text() { return this.view.state.doc.toString(); }

  /** Arm pick mode when the cursor sits where a target goes ("move ", "fade @a, "). */
  private updatePick(state: EditorState) {
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    const before = line.text.slice(0, sel.head - line.from);
    const m = sel.empty ? before.match(ScriptPanel.TARGETED) : null;
    this.pick = m ? { from: sel.head - m[2].length, to: sel.head } : undefined;
    this.pickEl.textContent = this.pick ? '🎯 Pick parts…' : '';
  }
  get picking() { return !!this.pick; }

  /** Insert a picked target at the pick position: replace the partial word, or append (", spec") when adding. */
  insertTarget(spec: string, add: boolean) {
    if (!this.pick) return;
    const { from, to } = this.pick;
    const cur = this.view.state.sliceDoc(from, to).replace(/,\s*$/, '');
    const parts = cur ? cur.split(',').map((x) => x.trim()).filter(Boolean) : [];
    const next = add ? [...parts.filter((p) => p !== spec), spec] : [spec];
    const insert = next.join(', ') + ' ';
    const after = this.view.state.sliceDoc(to, to + 1) === ' ' ? to + 1 : to; // don't double the space
    this.view.dispatch({ changes: { from, to: after, insert }, selection: { anchor: from + insert.length } });
    // stay armed so more parts can be added with ⌘/Ctrl-click
    this.pick = { from, to: from + insert.length - 1 };
    this.pickEl.textContent = '🎯 Pick parts… (⌘-click adds)';
    this.view.focus();
  }
  get dirty() { return this.text !== this.saved; }

  private updateDirty() { this.dirtyEl.textContent = this.dirty ? '● unsaved' : ''; }

  async save() {
    await this.hooks.save(this.text);
    this.saved = this.text;
    this.updateDirty();
  }

  /** Show parse/compile errors as lint marks; status shows ok / error count. */
  setErrors(errs: ParseError[]) {
    const doc = this.view.state.doc;
    const diags: Diagnostic[] = errs.map((e) => {
      const line = doc.line(Math.min(Math.max(e.line, 1), doc.lines));
      const from = e.from >= line.from && e.from <= line.to ? e.from : line.from;
      const to = Math.max(from + 1, Math.min(e.to >= from ? e.to : line.to, line.to));
      return { from, to: Math.min(to, doc.length), severity: 'error', message: e.message,
        actions: e.fix ? [{ name: e.fix.label, apply: () => e.fix!.run() }] : undefined };
    });
    this.view.dispatch(setDiagnostics(this.view.state, diags));
    this.status.className = 'status ' + (errs.length ? 'err' : 'ok');
    this.status.textContent = errs.length ? `${errs.length} error${errs.length > 1 ? 's' : ''}` : '✓';
  }

  /** Update step times (after a compile) and the active step (each frame; cheap when unchanged). */
  private lastKey = '';
  setTiming(lines: Map<number, LineTiming>, t: number) {
    const active = new Set<number>();
    for (const [ln, x] of lines) if (t >= x.start - 1e-6 && (t < x.end - 1e-6 || (x.end === x.start && Math.abs(t - x.start) < 1e-6))) active.add(ln);
    const key = [...active].join(',') + '|' + (lines === this.lastLines ? '' : Math.random());
    if (key === this.lastKey) return;
    this.lastKey = key; this.lastLines = lines;
    this.view.dispatch({ effects: setTimes.of({ lines, active }) });
  }
  private lastLines?: Map<number, LineTiming>;

  /** Line number of the cursor. */
  get cursorLine() { return this.view.state.doc.lineAt(this.view.state.selection.main.head).number; }

  runToCursor() {
    const { lines } = this.view.state.field(timesField);
    // the cursor line, or the nearest step above it
    for (let ln = this.cursorLine; ln >= 1; ln--) {
      const t = lines.get(ln);
      if (t) { this.hooks.seek(t.end); return; }
    }
  }

  /** Replace the text with an app-side edit (gizmo) as a minimal change and compile it now. */
  setText(next: string) {
    const a = this.text;
    if (a === next) return;
    let s = 0; while (s < a.length && s < next.length && a[s] === next[s]) s++;
    let e = 0; while (e < a.length - s && e < next.length - s && a[a.length - 1 - e] === next[next.length - 1 - e]) e++;
    this.view.dispatch({ changes: { from: s, to: a.length - e, insert: next.slice(s, next.length - e) } });
    clearTimeout(this.timer);
    this.hooks.change(next);
  }
}

// The Illustration tab's drawing-script editor (.draw, src/drawing/script.ts): CodeMirror with highlighting,
// diagnostics and completion of keywords / sheet names, plus Preview (the sheet at the cursor) and Save all.
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { DRAW_KEYWORDS, PAPERS, parseDraw, type DrawScript } from '../drawing/script';

const drawLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#') { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^"[^"]*"?/)) return 'string';
    if (stream.match(/^1:\d+/)) return 'number';
    if (stream.match(/^-?\d*\.?\d+s?\b/)) return 'number';
    if (stream.match(/^@[\w.-]+/)) return 'variableName.special';
    if (stream.match(/^[[\]{},]/)) return 'bracket';
    const w = stream.match(/^[^\s[\]{}",]+/) as RegExpMatchArray | null;
    if (!w) { stream.next(); return null; }
    if (stream.string.slice(0, stream.start).trim() === '' && DRAW_KEYWORDS.includes(w[0])) return 'keyword';
    if ([...PAPERS, 'landscape', 'portrait', 'fit', 'on', 'off', 'shaded', 'outline', 'hidden', 'none', 'half', 'quarter', 'at', 'iso', 'front', 'back', 'top', 'bottom', 'side', 'left', 'right'].includes(w[0])) return 'atom';
    return 'variableName';
  },
  languageData: { commentTokens: { line: '#' } },
});
const hl = HighlightStyle.define([
  { tag: tags.keyword, color: '#f2b705', fontWeight: '600' },
  { tag: tags.comment, color: '#5b6670', fontStyle: 'italic' },
  { tag: tags.string, color: '#a5d6a7' },
  { tag: tags.number, color: '#82aaff' },
  { tag: tags.special(tags.variableName), color: '#ff8c1a' },
  { tag: tags.variableName, color: '#d7dde4' },
  { tag: tags.atom, color: '#89ddff' },
  { tag: tags.bracket, color: '#7b8794' },
]);

export interface DrawPanelHooks {
  /** the text changed (typed by the user, or set by code) */
  change(text: string, typed: boolean): void;
  /** Preview every sheet, the named one shown first */
  preview(sheet: string): void;
  /** Draw every sheet and save the SVGs to the vault */
  saveAll(): void;
  /** the cursor moved into another sheet */
  cursor?(sheet: string | undefined): void;
  /** completion: named views, snapshots */
  views(): string[];
  snapshots(): string[];
}

export class DrawPanel {
  readonly el: HTMLElement;
  private view: EditorView;
  private status: HTMLElement;
  private busyEl: HTMLElement;
  private setting = false;
  private lastSheet: string | undefined;
  parsed: DrawScript;

  constructor(parent: HTMLElement, text: string, private hooks: DrawPanelHooks) {
    this.el = document.createElement('div'); this.el.className = 'draw-script';
    this.el.innerHTML = `<header><span>Drawing script</span><span class="st"></span><span style="flex:1"></span>
      <button data-a="preview" title="Render every sheet fast (PNG, in each sheet's style), save the PNGs to the vault and show them – the cursor's sheet first">▶ Preview</button>
      <button data-a="save" title="Draw every sheet and save SVG + PDF to the vault (Drawings/<animation>/<file or sheet>.svg, .pdf)">⤓ Save all</button></header>
      <div class="ed"></div><div class="busy" hidden></div>`;
    parent.appendChild(this.el);
    this.status = this.el.querySelector('.st')!;
    this.busyEl = this.el.querySelector('.busy')!;
    this.parsed = parseDraw(text);
    const complete = (ctx: CompletionContext) => {
      const line = ctx.state.doc.lineAt(ctx.pos), before = line.text.slice(0, ctx.pos - line.from);
      const w = ctx.matchBefore(/[\w"-]*$/);
      if (!w || (w.from === w.to && !ctx.explicit)) return null;
      const lead = before.trimStart();
      if (!/\s/.test(lead)) return { from: w.from, options: DRAW_KEYWORDS.map((k) => ({ label: k, type: 'keyword' })) };
      const kw = lead.split(/\s+/)[0];
      const opts: string[] = kw === 'view' ? ['iso', 'front', 'back', 'top', 'bottom', 'side', 'left', 'right', ...hooks.views().map((v) => `"${v}"`)]
        : kw === 'snapshot' ? hooks.snapshots().map((s) => `"${s}"`)
        : kw === 'paper' ? [...PAPERS, 'landscape', 'portrait'] : kw === 'cut' ? ['none', 'half', 'quarter', 'x', '-x', 'y', '-y', 'z', '-z', 'at']
        : kw === 'hidden' || kw === 'titleblock' ? ['on', 'off'] : kw === 'hatch' ? ['2.5', 'off'] : kw === 'fill' ? ['off', 'tint', 'colour'] : kw === 'style' ? ['outline', 'shaded', 'hidden'] : kw === 'dpi' ? ['96', '150', '300'] : kw === 'scale' ? ['fit', '1:10', '1:20', '1:50', '1:100', '1:200'] : [];
      return opts.length ? { from: w.from, options: opts.map((label) => ({ label, type: 'constant' })) } : null;
    };
    this.view = new EditorView({
      parent: this.el.querySelector('.ed')!,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(), history(), lintGutter(), drawLang, syntaxHighlighting(hl), autocompletion({ override: [complete] }),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.theme({
            '&': { fontSize: '12.5px', height: '100%', backgroundColor: 'transparent', color: '#d7dde4' },
            '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', caretColor: '#f2b705' },
            '.cm-gutters': { backgroundColor: 'transparent', color: '#5b6670', borderRight: '1px solid #222a33' },
            '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,.03)' },
            '&.cm-focused': { outline: 'none' },
            '.cm-tooltip': { backgroundColor: '#14191f', border: '1px solid #2b3540', color: '#d7dde4' },
          }, { dark: true }),
          EditorView.updateListener.of((u) => {
            if (u.selectionSet || u.docChanged) {
              const s = this.sheetAtCursor();
              if (s !== this.lastSheet) { this.lastSheet = s; this.hooks.cursor?.(s); }
            }
            if (!u.docChanged) return;
            const t = u.state.doc.toString();
            this.check(t);
            this.hooks.change(t, !this.setting);
          }),
        ],
      }),
    });
    this.check(text);
    this.el.querySelector<HTMLElement>('[data-a=preview]')!.onclick = () => {
      const s = this.sheetAtCursor();
      if (s) this.hooks.preview(s); else this.setStatus('No sheet here – put the cursor in a sheet', true);
    };
    this.el.querySelector<HTMLElement>('[data-a=save]')!.onclick = () => this.hooks.saveAll();
  }

  get text() { return this.view.state.doc.toString(); }
  setText(t: string) {
    if (t === this.text) return;
    this.setting = true;
    try { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: t } }); } finally { this.setting = false; }
  }
  /** The sheet the cursor is in (or the first sheet when it's in the defaults). */
  sheetAtCursor(): string | undefined {
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    const sheets = this.parsed.sheets;
    return [...sheets].reverse().find((s) => s.line <= line)?.name ?? sheets[0]?.name;
  }
  /** Errors from running a sheet (unknown parts, views…), shown on their lines with the parse errors. */
  setRunErrors(errs: { line: number; message: string }[]) { this.check(this.text, errs); }
  setStatus(msg: string, bad = false) { this.status.textContent = msg; this.status.style.color = bad ? '#ff6b6b' : '#7bd88f'; }
  busy(msg: string | null) { this.busyEl.hidden = !msg; this.busyEl.textContent = msg ?? ''; }

  private check(text: string, extra: { line: number; message: string }[] = []) {
    this.parsed = parseDraw(text);
    const all = [...this.parsed.errors, ...extra];
    const doc = this.view?.state.doc;
    if (doc) {
      const diags: Diagnostic[] = all.filter((e) => e.line >= 1 && e.line <= doc.lines).map((e) => {
        const l = doc.line(e.line);
        return { from: l.from, to: l.to, severity: 'error', message: e.message };
      });
      this.view.dispatch(setDiagnostics(this.view.state, diags));
    }
    if (all.length) this.setStatus(`${all.length} error${all.length > 1 ? 's' : ''}`, true);
    else this.setStatus(`✓ ${this.parsed.sheets.length} sheet${this.parsed.sheets.length === 1 ? '' : 's'}`);
  }
}

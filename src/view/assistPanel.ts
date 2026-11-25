/**
 * AI assist chat panel (after SolverKit's AssistPanel): streaming replies, tool notes,
 * proposal cards, Stop (Esc), edit & resend, regenerate, copy, usage.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { assistClient, runAssist, type AssistEvent, type AssistTool, type AssistUsage, type ChatMessage, type Proposal } from '../assist/loop';

export interface AssistHooks {
  system(): string;
  /** Live context for the next request (script, time, selection…). */
  context(): Promise<Anthropic.ContentBlockParam[]> | Anthropic.ContentBlockParam[];
  tools(): AssistTool[];
  /** Render a proposal card's body (diff etc.) and wire Accept/Reject. */
  renderProposal?(p: Proposal, el: HTMLElement, decide: (s: 'accepted' | 'rejected') => void): void;
  /** History changed (persist it). */
  saveHistory?(h: ChatMessage[]): void;
}

const CSS = `
#assist { flex: 1; min-height: 0; display: flex; flex-direction: column; color: #d7dde4; font: 12.5px/1.45 system-ui, sans-serif; }
#assist .bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #222a33; }
#assist .bar b { flex: 1; font-size: 12px; }
#assist .bar .st { font-size: 11px; color: #7b8794; }
#assist .bar .st.off { color: #e5484d; }
#assist button, #assist select { background: #222a33; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 2px 7px; cursor: pointer; font-size: 11px; }
#assist .log { flex: 1; min-height: 0; overflow: auto; padding: 8px; display: flex; flex-direction: column; gap: 10px; }
#assist .msg { border-radius: 6px; padding: 7px 9px; position: relative; white-space: pre-wrap; word-wrap: break-word; }
#assist .msg.user { background: #1d2a38; align-self: flex-end; max-width: 90%; }
#assist .msg.assistant { background: #14191f; border: 1px solid #222a33; }
#assist .msg pre { background: #0a0c0f; padding: 6px; border-radius: 4px; overflow: auto; white-space: pre; font: 11.5px ui-monospace, monospace; margin: 4px 0; }
#assist .msg code { font: 11.5px ui-monospace, monospace; background: #0a0c0f; padding: 0 3px; border-radius: 3px; }
#assist .note { color: #7b8794; font-size: 11px; font-style: italic; }
#assist .acts { display: none; gap: 4px; margin-top: 4px; }
#assist .msg:hover .acts { display: flex; }
#assist .acts button { font-size: 10px; padding: 0 5px; }
#assist .usage { color: #5b6670; font-size: 10px; margin-top: 4px; }
#assist .err { color: #e5484d; }
#assist .starters { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
#assist .starters button { text-align: left; padding: 6px 8px; font-size: 12px; }
#assist .card { border: 1px solid #2b3540; border-radius: 6px; padding: 6px 8px; margin-top: 6px; background: #0f1317; white-space: normal; }
#assist .card .sum { font-weight: 600; }
#assist .card .badge { font-size: 10px; padding: 1px 6px; border-radius: 8px; margin-left: 6px; }
#assist .card .badge.ok { background: #1e3a24; color: #7ee08a; } #assist .card .badge.bad { background: #3a1e1e; color: #ff8a8a; }
#assist .card .state { font-size: 11px; color: #7b8794; }
#assist .input { border-top: 1px solid #222a33; padding: 6px; display: flex; gap: 6px; align-items: flex-end; }
#assist textarea { flex: 1; resize: none; min-height: 34px; max-height: 160px; background: #0a0c0f; color: inherit; border: 1px solid #2b3540; border-radius: 4px; padding: 6px; font: inherit; }
`;

const STARTERS = [
  'What is in this model? Summarise the main assemblies.',
  'Lift @lid 3 m over 6 s, then move it 4 m to the side.',
  'Why does my script show an error?',
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
/** Minimal markdown: fenced code, inline code, bold. */
function md(text: string) {
  return esc(text)
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, c) => `<pre>${c.replace(/\n$/, '')}</pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
}

export class AssistPanel {
  el: HTMLElement;
  private log: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private status: HTMLElement;
  private effort: HTMLSelectElement;
  private client = assistClient();
  history: ChatMessage[] = [];
  private abort?: AbortController;
  private enabled = false;

  constructor(parent: HTMLElement, private hooks: AssistHooks, history: ChatMessage[] = []) {
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);
    this.el = document.createElement('div'); this.el.id = 'assist';
    this.el.innerHTML = `<div class="bar"><b>Assist</b><span class="st">checking…</span>
      <select title="Effort: how hard the model thinks"><option>low</option><option selected>medium</option><option>high</option><option>xhigh</option></select>
      <button data-a="new" title="Start a new conversation">New</button></div>
      <div class="log"></div>
      <div class="input"><textarea rows="2" placeholder="Ask about the model or describe an animation step… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button data-a="send">Send</button></div>`;
    parent.appendChild(this.el);
    this.log = this.el.querySelector('.log')!;
    this.input = this.el.querySelector('textarea')!;
    this.sendBtn = this.el.querySelector('[data-a=send]')!;
    this.status = this.el.querySelector('.st')!;
    this.effort = this.el.querySelector('select')!;
    this.history = history;
    this.sendBtn.onclick = () => (this.abort ? this.stop() : this.send());
    this.input.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!this.abort) this.send(); }
      if (e.key === 'Escape' && this.abort) this.stop();
      e.stopPropagation(); // keep viewer shortcuts (space, W/E/R) out of the chat box
    };
    this.input.oninput = () => { this.input.style.height = 'auto'; this.input.style.height = `${this.input.scrollHeight}px`; };
    this.el.querySelector<HTMLElement>('[data-a=new]')!.onclick = () => {
      if (this.abort) return;
      if (this.history.length && !confirm('Start a new conversation? The current one is cleared.')) return;
      this.history = []; this.hooks.saveHistory?.(this.history); this.render();
    };
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.abort) this.stop(); });
    fetch('/__assist/status').then((r) => r.json()).then((s) => {
      this.enabled = !!s.enabled;
      this.status.textContent = this.enabled ? 'claude-opus-5-5' : 'no API key';
      this.status.className = 'st' + (this.enabled ? '' : ' off');
      this.status.title = this.enabled ? '' : 'Add ANTHROPIC_API_KEY to .env and restart the dev server';
    }).catch(() => { this.status.textContent = 'proxy unavailable'; this.status.className = 'st off'; });
    this.render();
  }

  private stop() { this.abort?.abort(); }

  /** Send the input (or `text`) as a new user message. */
  async send(text = this.input.value.trim()) {
    if (!text || this.abort) return;
    this.input.value = ''; this.input.style.height = 'auto';
    this.history.push({ role: 'user', content: text });
    await this.reply();
  }

  /** Run a reply for the current history (last message is the user's). */
  private async reply() {
    const msg: ChatMessage = { role: 'assistant', content: '', proposals: [], tools: [] };
    this.history.push(msg);
    this.abort = new AbortController();
    this.sendBtn.textContent = 'Stop';
    this.render();
    const view = this.log.lastElementChild as HTMLElement;
    let usage: AssistUsage | undefined, errorText = '', writing = '';
    const paint = () => this.paintMessage(view, msg, { writing, error: errorText, usage, live: !!this.abort });
    let pending = false;
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; paint(); this.scroll(); }); } };
    try {
      const context = await this.hooks.context();
      for await (const ev of runAssist({
        client: this.client, system: this.hooks.system(), history: this.history.slice(0, -1), context,
        tools: this.hooks.tools(), effort: this.effort.value as any, signal: this.abort.signal,
      })) {
        this.onEvent(ev, msg, (w) => (writing = w), (e) => (errorText = e), (u) => (usage = u));
        schedule();
      }
    } catch (e: any) {
      if (!this.abort?.signal.aborted) errorText = String(e?.message ?? e);
    }
    if (this.abort?.signal.aborted && !msg.content) msg.content = '(stopped)';
    this.abort = undefined;
    this.sendBtn.textContent = 'Send';
    writing = '';
    paint();
    this.hooks.saveHistory?.(this.history);
    this.scroll();
  }

  private onEvent(ev: AssistEvent, msg: ChatMessage, setWriting: (s: string) => void, setErr: (s: string) => void, setUsage: (u: AssistUsage) => void) {
    switch (ev.type) {
      case 'text': msg.content += ev.text; setWriting(''); break;
      case 'tool': msg.tools!.push(ev.label); break;
      case 'writing': setWriting(`writing ${ev.what}… ${ev.chars} chars`); break;
      case 'round': break;
      case 'proposal': msg.proposals!.push(ev.proposal); setWriting(''); break;
      case 'done': setUsage(ev.usage); break;
      case 'error': setErr(ev.message); break;
    }
  }

  private scroll() { this.log.scrollTop = this.log.scrollHeight; }

  private render() {
    this.log.replaceChildren();
    if (!this.history.length) {
      const s = document.createElement('div');
      s.innerHTML = `<div class="note">Ask about the model, or describe animation steps. Changes are proposed for you to accept.</div><div class="starters"></div>`;
      for (const t of STARTERS) {
        const b = document.createElement('button'); b.textContent = t;
        b.onclick = () => this.send(t);
        s.querySelector('.starters')!.appendChild(b);
      }
      this.log.appendChild(s);
      return;
    }
    this.history.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = `msg ${m.role}`;
      this.log.appendChild(el);
      this.paintMessage(el, m, { index: i });
    });
    this.scroll();
  }

  private paintMessage(el: HTMLElement, m: ChatMessage, o: { index?: number; writing?: string; error?: string; usage?: AssistUsage; live?: boolean }) {
    const i = o.index ?? this.history.indexOf(m);
    const isLastAssistant = m.role === 'assistant' && i === this.history.length - 1;
    el.innerHTML = `${(m.tools ?? []).map((t) => `<div class="note">⚙ ${esc(t)}</div>`).join('')}
      <div class="body">${md(m.content) || (o.live ? '<span class="note">…</span>' : '')}</div>
      ${o.writing ? `<div class="note">${esc(o.writing)}</div>` : ''}
      <div class="cards"></div>
      ${o.error ? `<div class="err">${esc(o.error)}</div>` : ''}
      ${o.usage ? `<div class="usage">${o.usage.input + o.usage.cache_read + o.usage.cache_write} in (${o.usage.cache_read} cached) · ${o.usage.output} out</div>` : ''}
      <div class="acts"><button data-a="copy">Copy</button>${m.role === 'user' ? '<button data-a="edit">Edit</button>' : ''}${isLastAssistant && !o.live ? '<button data-a="regen">Regenerate</button>' : ''}</div>`;
    const cards = el.querySelector('.cards')!;
    for (const p of m.proposals ?? []) {
      const c = document.createElement('div'); c.className = 'card';
      c.innerHTML = `<div><span class="sum">${esc(p.summary)}</span><span class="badge ${p.check.ok ? 'ok' : 'bad'}">${esc(p.check.label)}</span></div><div class="pbody"></div>
        <div class="state">${p.state ? (p.state === 'accepted' ? '✓ accepted' : '✕ rejected') : ''}</div>`;
      cards.appendChild(c);
      this.hooks.renderProposal?.(p, c.querySelector('.pbody')!, (s) => {
        p.state = s;
        c.querySelector('.state')!.textContent = s === 'accepted' ? '✓ accepted' : '✕ rejected';
        this.hooks.saveHistory?.(this.history);
      });
    }
    const act = (a: string, f: () => void) => el.querySelector<HTMLElement>(`[data-a=${a}]`)?.addEventListener('click', f);
    act('copy', () => navigator.clipboard?.writeText(m.content));
    act('edit', () => {
      if (this.abort) return;
      this.input.value = m.content;
      this.history = this.history.slice(0, i); // the conversation from here is replaced on send
      this.render(); this.input.focus();
    });
    act('regen', () => {
      if (this.abort) return;
      this.history = this.history.slice(0, i);
      this.render(); this.reply();
    });
  }
}

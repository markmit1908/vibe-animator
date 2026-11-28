/**
 * AI assist loop (after SolverKit's packages/app/src/assist/loop.ts), on the official Anthropic SDK.
 * Runs in the browser; requests go to the server's key proxy (SolverKit /api/assist/proxy), which adds the API key.
 *
 *  - system prompt (the app's reference) is cached; the live context goes in front of the latest user message
 *  - tools run here; proposal tools yield `proposal` events the panel shows as Accept / Reject cards
 *  - nothing changes the scene or script without the user's Accept
 */
import Anthropic from '@anthropic-ai/sdk';

export const ASSIST_MODEL = 'claude-opus-5-5';
export const ASSIST_MAX_TOKENS = 64000;
export const ASSIST_MAX_ROUNDS = 8;
/** No stream event (data or ping) for this long: the connection is dead – end the turn, keeping its proposals. */
export const ASSIST_STALL_MS = 120_000;

// ---------- protocol (SolverKit's AssistEvent) ----------
export interface Proposal {
  kind: string;
  summary: string;
  check: { ok: boolean; label: string };
  state?: 'accepted' | 'rejected';
  [field: string]: unknown;
}
/** One message per proposal (SolverKit's ChatMessage); a reply's text goes with its last message. */
export interface ChatMessage { role: 'user' | 'assistant'; content: string; proposal?: Proposal }
/** Chats saved before the SolverKit panel kept a reply's proposals in one message (`proposals[]`, `tools[]`). */
export function migrateChat(c: unknown): ChatMessage[] {
  if (!Array.isArray(c)) return [];
  return c.flatMap((m: any): ChatMessage[] => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return [];
    const ps: Proposal[] = m.proposal ? [m.proposal] : Array.isArray(m.proposals) ? m.proposals : [];
    if (!ps.length) return [{ role: m.role, content: String(m.content ?? '') }];
    const out: ChatMessage[] = ps.map((p) => ({ role: 'assistant', content: '', proposal: p }));
    out[out.length - 1].content = String(m.content ?? '');
    return out;
  });
}
export interface AssistUsage { input: number; output: number; cache_read: number; cache_write: number }
export type AssistEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'round'; round: number; of: number }
  | { type: 'writing'; what: string; chars: number }
  | ({ type: 'proposal'; kind: string; summary: string; check: Proposal['check'] } & Record<string, unknown>)
  | { type: 'done'; model: string; usage: AssistUsage; stop_reason?: string | null }
  | { type: 'error'; message: string };

export interface ToolResult { content: string | Anthropic.ToolResultBlockParam['content']; is_error?: boolean }
export interface AssistTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  /** What the panel says while the call's input streams ("a script edit"). */
  writing?: string;
  /** Validate input; return an error message when it doesn't fit the schema. */
  validate?(input: any): string | undefined;
  run(input: any): AsyncGenerator<AssistEvent, ToolResult, void>;
}

export function assistClient(base = '/api/assist/proxy') {
  // The proxy holds the key; the SDK needs a placeholder and browser opt-in.
  return new Anthropic({
    baseURL: new URL(base, location.href).href,
    apiKey: 'held-by-the-dev-server',
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });
}

/** Earlier assistant turns as the model sees them: text plus what became of each proposal. */
function noteFor(m: ChatMessage) {
  let t = m.content || '';
  for (const p of m.proposal ? [m.proposal] : []) {
    const s = p.state === 'accepted' ? 'accepted it' : p.state === 'rejected' ? 'rejected it' : 'has not decided yet';
    t += `\n\n[I proposed a ${p.kind}: ${p.summary}. The user ${s}.]`;
  }
  return t.trim() || '(no text)';
}

/** History → API messages, with the live context in front of the latest user message. */
export function messagesFor(history: ChatMessage[], context: Anthropic.ContentBlockParam[]): Anthropic.MessageParam[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history) {
    if (!m.content && !m.proposal) continue;
    const c = m.role === 'assistant' ? noteFor(m) : m.content;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${c}`;
    else out.push({ role: m.role, content: c });
  }
  const last = out.pop();
  if (!last || last.role !== 'user') throw new Error("the last message must be the user's");
  return [...out, { role: 'user', content: [...context, { type: 'text', text: last.content }] }];
}

export interface AssistRun {
  client: Anthropic;
  system: string;
  history: ChatMessage[];
  /** Live context blocks (text, and optionally an image), rebuilt per message. */
  context: Anthropic.ContentBlockParam[];
  tools: AssistTool[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
  /** verbose transaction log: one record per thing that happens (the caller writes them out) */
  log?: (rec: Record<string, unknown>) => void;
  /** sent with each request (x-assist-send) so the server's proxy log lines up with this one */
  sendId?: string;
  /** dead-stream timeout (default ASSIST_STALL_MS) */
  stallMs?: number;
}

/** One reply: streams events until the model finishes (or the user stops it). */
export async function* runAssist(o: AssistRun): AsyncGenerator<AssistEvent, void, void> {
  const usage: AssistUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const toolDefs = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
  const messages: Anthropic.Beta.BetaMessageParam[] = messagesFor(o.history, o.context) as any;
  const log = o.log ?? (() => {});
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  log({ ev: 'send', model: ASSIST_MODEL, effort: o.effort ?? 'medium', max_tokens: ASSIST_MAX_TOKENS, max_rounds: ASSIST_MAX_ROUNDS,
    tools: o.tools.map((t) => t.name), system_chars: o.system.length, system: o.system });
  let sent = 0;   // messages already logged
  let model = ASSIST_MODEL;
  let retries = 0;
  for (let round = 1; round <= ASSIST_MAX_ROUNDS; round++) {
    if (round > 1) yield { type: 'round', round, of: ASSIST_MAX_ROUNDS };
    log({ ev: 'request', round, at_ms: ms(), retry: retries || undefined, new_messages: messages.slice(sent) });
    sent = messages.length;
    const rt0 = performance.now();
    const stream = o.client.beta.messages.stream({
      model: ASSIST_MODEL,
      max_tokens: ASSIST_MAX_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',            // policy declines re-run on a fallback model inside the same call
      thinking: { type: 'adaptive' },
      output_config: { effort: o.effort ?? 'medium' },
      cache_control: { type: 'ephemeral' }, // caches system + tools + history prefix
      system: o.system,
      tools: toolDefs as any,
      messages,
    } as any, { signal: o.signal, ...(o.sendId ? { headers: { 'x-assist-send': `${o.sendId}#${round}` } } : {}) });

    // stream text and tool-input progress
    const writing = new Map<number, { what: string; chars: number }>();
    const queue: AssistEvent[] = [];
    let wake: (() => void) | undefined;
    // the log: each content block whole (deltas gathered), message start / end, pings counted, gaps noted
    const blocks = new Map<number, { type: string; name?: string; text: string; started: number }>();
    let lastEv = performance.now(), firstEv = 0, pings = 0, maxGap = 0;
    stream.on('streamEvent', (ev: any) => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - lastEv); lastEv = now;
      if (!firstEv) { firstEv = now; log({ ev: 'first_event', round, after_ms: Math.round(now - rt0) }); }
      if (ev.type === 'ping') pings++;
      else if (ev.type === 'message_start') log({ ev: 'message_start', round, id: ev.message?.id, model: ev.message?.model, usage: ev.message?.usage });
      else if (ev.type === 'message_delta') log({ ev: 'message_delta', round, stop_reason: ev.delta?.stop_reason, usage: ev.usage });
      else if (ev.type === 'content_block_start') blocks.set(ev.index, { type: ev.content_block.type, name: ev.content_block.name, text: ev.content_block.text ?? '', started: now });
      else if (ev.type === 'content_block_delta') {
        const b = blocks.get(ev.index), d = ev.delta;
        if (b) b.text += d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : d.type === 'input_json_delta' ? d.partial_json : '';
      } else if (ev.type === 'content_block_stop') {
        const b = blocks.get(ev.index);
        if (b) log({ ev: 'block', round, index: ev.index, type: b.type, name: b.name, block_ms: Math.round(now - b.started), chars: b.text.length, content: b.text });
      }
      if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
        const t = o.tools.find((x) => x.name === ev.content_block.name);
        writing.set(ev.index, { what: t?.writing ?? ev.content_block.name, chars: 0 });
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') queue.push({ type: 'text', text: ev.delta.text });
        else if (ev.delta.type === 'input_json_delta') {
          const w = writing.get(ev.index);
          if (w) { w.chars += ev.delta.partial_json.length; queue.push({ type: 'writing', what: w.what, chars: w.chars }); }
        }
      }
      wake?.();
    });
    const done = stream.finalMessage().then((m) => ({ m }), (e) => ({ e }));
    let finished: { m?: any; e?: any } | undefined;
    done.then((r) => { finished = r; log({ ev: 'final_message', round, ok: !('e' in r), queued: queue.length }); wake?.(); });
    // dead stream: nothing (not even a ping) for stallMs → abort this request and end the turn
    let stalled = false;
    const stallMs = o.stallMs ?? ASSIST_STALL_MS;
    const watch = setInterval(() => {
      if (finished || performance.now() - lastEv < stallMs) return;
      stalled = true;
      log({ ev: 'stall', round, silent_ms: Math.round(performance.now() - lastEv), pings, blocks_open: [...blocks.values()].map((b) => ({ type: b.type, name: b.name, chars: b.text.length })) });
      stream.abort();
    }, Math.min(5000, stallMs / 4));
    try {
      while (!finished || queue.length) {
        if (queue.length) { yield queue.shift()!; continue; }
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally { clearInterval(watch); }
    log({ ev: 'response', round, round_ms: Math.round(performance.now() - rt0), pings, max_gap_ms: Math.round(maxGap),
      ...(finished.e ? { error: String(finished.e?.message ?? finished.e), status: finished.e?.status } : { stop_reason: finished.m?.stop_reason, usage: finished.m?.usage, model: finished.m?.model }) });
    if (finished.e) {
      const e = finished.e;
      if (stalled) {
        yield { type: 'error', message: `The connection to the assistant stopped (no data for ${Math.round(stallMs / 1000)} s). What it proposed so far is kept – send again to retry.` };
        log({ ev: 'end', reason: 'stall', at_ms: ms() });
        return;
      }
      if (o.signal?.aborted) { log({ ev: 'end', reason: 'stopped by the user', at_ms: ms() }); return; }
      if (e instanceof Anthropic.APIError) { log({ ev: 'end', reason: 'api error', at_ms: ms() }); yield { type: 'error', message: apiErrorText(e) }; return; }
      if (retries++ < 2) { log({ ev: 'retry', round, reason: String(e?.message ?? e) }); round--; continue; } // unparseable tool input or dropped connection: re-issue the turn
      log({ ev: 'end', reason: 'error', at_ms: ms() });
      yield { type: 'error', message: String(e?.message ?? e) }; return;
    }
    retries = 0;
    const msg = finished.m as Anthropic.Beta.BetaMessage;
    model = msg.model;
    usage.input += msg.usage.input_tokens; usage.output += msg.usage.output_tokens;
    usage.cache_read += msg.usage.cache_read_input_tokens ?? 0; usage.cache_write += msg.usage.cache_creation_input_tokens ?? 0;

    if (msg.stop_reason === 'refusal') { log({ ev: 'end', reason: 'refusal', at_ms: ms() }); yield { type: 'error', message: 'The request was declined.' }; break; }
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); sent = messages.length; continue; }
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!calls.length) { log({ ev: 'end', reason: 'done', stop_reason: msg.stop_reason, usage, at_ms: ms() }); yield { type: 'done', model, usage, stop_reason: msg.stop_reason }; return; }
    if (msg.stop_reason === 'max_tokens') { log({ ev: 'end', reason: 'max_tokens in a tool call', at_ms: ms() }); yield { type: 'error', message: 'Reply was cut off (output limit) while writing a tool call.' }; break; }

    messages.push({ role: 'assistant', content: msg.content });
    sent = messages.length;   // the response is in the log already (as blocks)
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const tool = o.tools.find((t) => t.name === call.name);
      let r: ToolResult;
      const tt0 = performance.now();
      log({ ev: 'tool_call', round, name: call.name, id: call.id, input: call.input });
      if (!tool) r = { content: `Unknown tool ${call.name}`, is_error: true };
      else {
        const bad = tool.validate?.(call.input);
        if (bad) r = { content: `Invalid input: ${bad}`, is_error: true };
        else {
          try {
            const gen = tool.run(call.input);
            let step = await gen.next();
            while (!step.done) {
              if (step.value.type === 'proposal') { const { type: _t, ...p } = step.value; log({ ev: 'proposal', round, ...p }); }
              yield step.value; step = await gen.next();
            }
            r = step.value;
          } catch (e: any) { r = { content: `Tool failed: ${e?.message ?? e}`, is_error: true }; }
        }
      }
      log({ ev: 'tool_result', round, name: call.name, id: call.id, tool_ms: Math.round(performance.now() - tt0), is_error: r.is_error,
        content: typeof r.content === 'string' ? r.content : (r.content as any[]).map((b) => b.type === 'text' ? b.text : `[${b.type}]`).join('\n') });
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content as any, is_error: r.is_error });
    }
    messages.push({ role: 'user', content: results }); // all results in one message
  }
  log({ ev: 'end', reason: 'max rounds', usage, at_ms: ms() });
  yield { type: 'done', model, usage, stop_reason: 'max_rounds' };
}

function apiErrorText(e: InstanceType<typeof Anthropic.APIError>) {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected – check ANTHROPIC_API_KEY in .env.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited – try again in a moment.';
  if (e.status === 503) return 'Assist unavailable: no ANTHROPIC_API_KEY in .env (restart the dev server after adding it).';
  return `API error ${e.status ?? ''}: ${e.message}`;
}

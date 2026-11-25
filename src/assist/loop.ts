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

// ---------- protocol (SolverKit's AssistEvent) ----------
export interface Proposal {
  kind: string;
  summary: string;
  check: { ok: boolean; label: string };
  state?: 'accepted' | 'rejected';
  [field: string]: unknown;
}
export interface ChatMessage { role: 'user' | 'assistant'; content: string; proposals?: Proposal[]; tools?: string[] }
export interface AssistUsage { input: number; output: number; cache_read: number; cache_write: number }
export type AssistEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; label: string }
  | { type: 'round'; round: number; of: number }
  | { type: 'writing'; what: string; chars: number }
  | { type: 'proposal'; proposal: Proposal }
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
  for (const p of m.proposals ?? []) {
    const s = p.state === 'accepted' ? 'accepted it' : p.state === 'rejected' ? 'rejected it' : 'has not decided yet';
    t += `\n\n[I proposed a ${p.kind}: ${p.summary}. The user ${s}.]`;
  }
  return t.trim() || '(no text)';
}

/** History → API messages, with the live context in front of the latest user message. */
export function messagesFor(history: ChatMessage[], context: Anthropic.ContentBlockParam[]): Anthropic.MessageParam[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of history) {
    if (!m.content && !m.proposals?.length) continue;
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
}

/** One reply: streams events until the model finishes (or the user stops it). */
export async function* runAssist(o: AssistRun): AsyncGenerator<AssistEvent, void, void> {
  const usage: AssistUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const toolDefs = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true }));
  const messages: Anthropic.Beta.BetaMessageParam[] = messagesFor(o.history, o.context) as any;
  let model = ASSIST_MODEL;
  let retries = 0;
  for (let round = 1; round <= ASSIST_MAX_ROUNDS; round++) {
    if (round > 1) yield { type: 'round', round, of: ASSIST_MAX_ROUNDS };
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
    } as any, { signal: o.signal });

    // stream text and tool-input progress
    const writing = new Map<number, { what: string; chars: number }>();
    const queue: AssistEvent[] = [];
    let wake: (() => void) | undefined;
    stream.on('streamEvent', (ev: any) => {
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
    done.then((r) => { finished = r; wake?.(); });
    while (!finished || queue.length) {
      if (queue.length) { yield queue.shift()!; continue; }
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
    if (finished.e) {
      const e = finished.e;
      if (o.signal?.aborted) return;
      if (e instanceof Anthropic.APIError) { yield { type: 'error', message: apiErrorText(e) }; return; }
      if (retries++ < 2) { round--; continue; } // unparseable tool input or dropped connection: re-issue the turn
      yield { type: 'error', message: String(e?.message ?? e) }; return;
    }
    retries = 0;
    const msg = finished.m as Anthropic.Beta.BetaMessage;
    model = msg.model;
    usage.input += msg.usage.input_tokens; usage.output += msg.usage.output_tokens;
    usage.cache_read += msg.usage.cache_read_input_tokens ?? 0; usage.cache_write += msg.usage.cache_creation_input_tokens ?? 0;

    if (msg.stop_reason === 'refusal') { yield { type: 'error', message: 'The request was declined.' }; break; }
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
    const calls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!calls.length) { yield { type: 'done', model, usage, stop_reason: msg.stop_reason }; return; }
    if (msg.stop_reason === 'max_tokens') { yield { type: 'error', message: 'Reply was cut off (output limit) while writing a tool call.' }; break; }

    messages.push({ role: 'assistant', content: msg.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const tool = o.tools.find((t) => t.name === call.name);
      let r: ToolResult;
      if (!tool) r = { content: `Unknown tool ${call.name}`, is_error: true };
      else {
        const bad = tool.validate?.(call.input);
        if (bad) r = { content: `Invalid input: ${bad}`, is_error: true };
        else {
          try {
            const gen = tool.run(call.input);
            let step = await gen.next();
            while (!step.done) { yield step.value; step = await gen.next(); }
            r = step.value;
          } catch (e: any) { r = { content: `Tool failed: ${e?.message ?? e}`, is_error: true }; }
        }
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: r.content as any, is_error: r.is_error });
    }
    messages.push({ role: 'user', content: results }); // all results in one message
  }
  yield { type: 'done', model, usage, stop_reason: 'max_rounds' };
}

function apiErrorText(e: InstanceType<typeof Anthropic.APIError>) {
  if (e instanceof Anthropic.AuthenticationError) return 'The API key was rejected – check ANTHROPIC_API_KEY in .env.';
  if (e instanceof Anthropic.RateLimitError) return 'Rate limited – try again in a moment.';
  if (e.status === 503) return 'Assist unavailable: no ANTHROPIC_API_KEY in .env (restart the dev server after adding it).';
  return `API error ${e.status ?? ''}: ${e.message}`;
}

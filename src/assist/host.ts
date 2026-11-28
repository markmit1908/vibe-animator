/**
 * What the studio gives the assist panel. The panel itself is SolverKit's AssistPanel (React), mounted by the app
 * (app/src/assist.tsx) through `StudioIO.mountAssist`; the studio (plain DOM) only supplies this.
 */
import type { AssistEvent, ChatMessage, Proposal } from './loop';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AssistHost {
  chat(): ChatMessage[];
  /** The conversation changed: persist it. */
  onChat(c: ChatMessage[]): void;
  /** Start a reply to `history` (its last message is the user's). */
  start(history: ChatMessage[], signal: AbortSignal, effort: Effort): AsyncIterable<AssistEvent>;
  /** Apply an accepted proposal. */
  accept(p: Proposal): void | Promise<void>;
  /** The script text now (to diff a proposal against). */
  script(): string;
  /** Play a proposed script without touching the editor (undefined: end the preview). */
  preview(p: Proposal | undefined): void;
  /** The proposal being previewed (its script text), if any. */
  previewing(): string | undefined;
  /** Insert code from a reply into the script after the cursor line. */
  insertCode(code: string): void;
  /** The key proxy's status URL. */
  status: string;
}

export interface AssistMount {
  /** Something the cards show changed (script text, preview). */
  refresh(): void;
  /** Send a message (tests, "Ask AI" buttons). */
  send(text: string): void;
  dispose(): void;
}

// ---- stop-gaps for SolverKit's AssistPanel (solverkit-candidate) ----
// The panel shows a turn's proposals without Accept / Reject until the turn ends, and Stop drops them. The app lets
// a card be decided while the turn runs (applied at once) and puts a stopped turn's proposals back; this remembers
// what was decided, by the proposal's content, so the panel's own decision later neither repeats nor loses it.

/** A proposal's identity across the panel's copies of it (its content, without the decision). */
export function proposalKey(p: Proposal): string {
  const { state: _s, type: _t, review: _r, ...rest } = p as Proposal & { type?: unknown; review?: unknown };
  return JSON.stringify(rest);
}
/** Proposals decided while their turn was still running: key → accepted? */
export const decidedEarly = new Map<string, boolean>();

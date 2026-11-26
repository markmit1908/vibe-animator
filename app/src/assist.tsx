// The Studio's Assist tab: SolverKit's AssistPanel (composer, streaming, Stop/Edit/Regenerate/Copy/Clear, proposal
// queue) over the studio's assist loop (AssistHost). Our proposal kinds (script edit, groups, part state) are
// registered here as SolverKit proposal kinds. The studio is plain DOM, so this mounts its own React root.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistPanel, CheckBadge, TextDiffCard, proposalKinds, replyMarkdown } from "@solverkit/app";
import type { AssistSeed, ChatMessage as SkChat, Proposal as SkProposal } from "@solverkit/app";
import { Button } from "@solverkit/ui";
import { Pause, Play } from "lucide-react";
import type { AssistHost, AssistMount, Effort } from "../../src/assist/host";
import type { ChatMessage, Proposal } from "../../src/assist/loop";

interface View { host: AssistHost; script: string; previewing?: string }

const STARTERS = [
  "What is in this model? Summarise the main assemblies.",
  "Lift @lid 3 m over 6 s, then move it 4 m to the side.",
  "Why does my script show an error?",
];

// ---------- proposal kinds ----------
function ChangeCard({ p, title, lines, onDecide }: { p: SkProposal; title: string; lines: React.ReactNode[]; onDecide?: (a: boolean) => void }) {
  const problems = (p.problems as string[] | undefined) ?? [];
  return (
    <div className="overflow-hidden rounded-lg border" data-testid="proposal">
      <div className="flex items-start gap-2 border-b bg-muted/40 px-3 py-2">
        <span className="min-w-0 flex-1 text-sm"><span className="text-muted-foreground">{title}:</span> {p.summary}</span>
        <CheckBadge check={p.check} title="Checked against the scene before it was proposed" />
      </div>
      <ul className="list-disc space-y-0.5 py-2 pl-7 pr-3 text-xs">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {problems.length > 0 && <p className="px-3 pb-2 text-xs text-destructive">{problems.join(" · ")}</p>}
      <div className="flex items-center gap-2 border-t px-3 py-2">
        {p.state
          ? <span className="text-xs text-muted-foreground">{p.state === "accepted" ? "Accepted" : "Rejected"}</span>
          : onDecide && <>
              <Button size="xs" disabled={!p.check.ok} onClick={() => onDecide(true)}>Accept</Button>
              <Button size="xs" variant="outline" onClick={() => onDecide(false)}>Reject</Button>
            </>}
      </div>
    </div>
  );
}

const short = (ids: string[]) => ids.slice(0, 4).map((x) => x.split("/").pop()).join(", ") + (ids.length > 4 ? " …" : "");
const plural = (n: number) => `${n} part${n === 1 ? "" : "s"}`;

let registered = false;
function registerKinds() {
  if (registered) return;
  registered = true;
  proposalKinds.register({
    id: "script edit",
    queueLabel: () => "Script",
    render: (p: SkProposal, v: View, onDecide?: (a: boolean) => void) => {
      const errs = (p.errors as { line: number; message: string }[] | undefined) ?? [];
      const unlock = (p.unlock as string[] | undefined) ?? [];
      const on = v.previewing === p.text;
      return (
        <div className="space-y-1">
          <TextDiffCard p={p} title="Proposed script edit" proposed={String(p.text)} current={v.script}
            checkTitle="Compiled against the scene before it was proposed" onDecide={onDecide} />
          {!p.state && (errs.length > 0 || unlock.length > 0 || p.check.ok) && (
            <div className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
              {p.check.ok && (
                <Button size="xs" variant="outline" onClick={() => v.host.preview(on ? undefined : (p as unknown as Proposal))}>
                  {on ? <><Pause /> End preview</> : <><Play /> Preview</>}
                </Button>)}
              {unlock.length > 0 && <span title={unlock.join("\n")}>🔓 Accept also unlocks {short(unlock)}{unlock.length > 1 ? ` (${unlock.length} parts)` : ""}.</span>}
              {errs.length > 0 && <span className="text-destructive">{errs.map((e) => `line ${e.line}: ${e.message}`).join(" · ")}</span>}
            </div>)}
        </div>
      );
    },
  });
  proposalKinds.register({
    id: "groups",
    queueLabel: () => "Groups",
    render: (p: SkProposal, _v: View, onDecide?: (a: boolean) => void) => (
      <ChangeCard p={p} title="Groups" onDecide={onDecide} lines={(p.changes as { action: string; name: string; ids: string[] }[]).map((c) =>
        <>{c.action} <b>@{c.name}</b>{c.ids.length ? ` – ${plural(c.ids.length)}: ${short(c.ids)}` : ""}</>)} />
    ),
  });
  proposalKinds.register({
    id: "state",
    queueLabel: () => "Parts",
    render: (p: SkProposal, _v: View, onDecide?: (a: boolean) => void) => (
      <ChangeCard p={p} title="Part state" onDecide={onDecide} lines={(p.changes as {
        targets: string[]; ids: string[]; lock?: boolean; hide?: boolean; color?: string | null; remove?: boolean;
      }[]).map((c) => <>
        {[c.lock === true && "🔒 lock", c.lock === false && "🔓 unlock", c.hide === true && "hide", c.hide === false && "show",
          c.color === null && "reset colour", c.remove === true && "remove from assembly", c.remove === false && "restore"].filter(Boolean).join(" + ")}
        {c.color && <> colour <span className="inline-block size-2.5 rounded-sm border align-middle" style={{ background: c.color }} /> {c.color}</>}
        {` – ${c.targets.join(", ")} (${plural(c.ids.length)})`}
      </>)} />
    ),
  });
}

// ---------- the tab ----------
/** Replies as Markdown; each code block gets "Insert into script". */
const replyHtml = (md: string) => replyMarkdown(md).replace(/<\/pre>/g,
  '</pre><button type="button" data-insert class="mb-2 rounded border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">⤓ Insert into script</button>');

function AssistTab({ host, bus }: { host: AssistHost; bus: Bus }) {
  const [chat, setChat] = useState<ChatMessage[]>(() => host.chat());
  const [tick, setTick] = useState(0);
  const [seed, setSeed] = useState<AssistSeed | null>(null);
  const [effort, setEffort] = useState<Effort>("low")   // fast by default; medium/high for harder requests;
  const [status, setStatus] = useState<{ ok: boolean; text: string }>({ ok: true, text: "checking…" });
  useEffect(() => {
    bus.refresh = () => { setChat(host.chat()); setTick((t) => t + 1); };
    bus.send = (text) => setSeed({ id: Date.now(), text });
  }, [bus, host]);
  useEffect(() => {
    fetch(host.status).then((r) => r.json()).then((s) => {
      const ok = !!(s.enabled ?? s.key ?? s.available);
      setStatus({ ok, text: ok ? (s.model ?? "claude-opus-5-5") : "no API key – add ANTHROPIC_API_KEY to .env and restart" });
    }).catch(() => setStatus({ ok: false, text: "assist proxy unavailable" }));
  }, [host]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo<View>(() => ({ host, script: host.script(), previewing: host.previewing() }), [host, tick, chat]);
  return (
    <div className="dark flex h-full min-h-0 flex-col bg-background text-foreground"
      onKeyDown={(e) => e.stopPropagation() /* keep viewer shortcuts (Space, W/E/R) out of the chat */}>
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className={`min-w-0 flex-1 truncate ${status.ok ? "" : "text-destructive"}`} data-testid="assist-status">{status.text}</span>
        <label className="flex items-center gap-1" title="How hard the model thinks">Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value as Effort)}
            className="rounded border bg-background px-1 py-0.5 text-xs text-foreground">
            {(["low", "medium", "high", "xhigh"] as const).map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>
      </div>
      <AssistPanel<View>
        chat={chat as SkChat[]}
        onChat={(c) => { setChat(c as ChatMessage[]); host.onChat(c as ChatMessage[]); }}
        start={(history, signal) => ({ events: host.start(history as ChatMessage[], signal, effort) as AsyncIterable<never> })}
        view={view}
        onAccept={(p) => { void Promise.resolve(host.accept(p as unknown as Proposal)).then(() => setTick((t) => t + 1)); }}
        seed={seed}
        starters={STARTERS}
        intro="Ask about the model, or describe animation steps. Changes come as proposals for you to accept."
        placeholder="Ask about the model or describe an animation step…"
        privacy="Sends the script, the selection and the top of the assembly tree to Anthropic when you send a message."
        replyHtml={replyHtml}
        onReplyClick={(e) => {
          const b = (e.target as HTMLElement).closest("[data-insert]");
          const pre = b?.previousElementSibling;
          if (pre?.tagName === "PRE") host.insertCode(pre.textContent ?? "");
        }}
      />
    </div>
  );
}

interface Bus { refresh(): void; send(text: string): void }

export function mountAssist(el: HTMLElement, host: AssistHost): AssistMount {
  registerKinds();
  const bus: Bus = { refresh() {}, send() {} };
  const root = createRoot(el);
  root.render(<AssistTab host={host} bus={bus} />);
  return { refresh: () => bus.refresh(), send: (t) => bus.send(t), dispose: () => setTimeout(() => root.unmount()) };
}

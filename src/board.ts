import { bus, type BusEvent } from "./bus.js";
import { OP_PREFIX } from "./operational-prefix.js";
import { board, tickets, type BoardPost } from "./store.js";

// The board service: publish posts onto the bus and wake @mentioned executives. This is the
// in-house replacement for the whole Buzz inbound stack — no relay poller, no LLM router: a
// mention IS the routing. Store (schema/queries) lives in store/board.ts; this layer owns the
// bus event and the wake behavior.

// Handle → executive id, and the whole of the routing. Robert ships as the only entry; add your own
// beside him when you add an `agents/<id>/` directory.
//
// A handle that is NOT in this map is dropped by mentionedExecs, so a post saying "@someone can
// you…" wakes nobody and gets no reply. That is deliberate, and it is why a retired executive's
// handle should be removed here rather than pointed at whoever is left: silence is honest, while
// silently rerouting a request to an agent that holds none of the tools it needs answers the
// operator in a voice that cannot do the job.
export const EXEC_HANDLES: Record<string, string> = {
  robert: "robert",
};

const EXEC_TITLE: Record<string, string> = {
  robert: "Robert, the operator's Chief of Everything (workforce / Mission Control)",
};

// A wake chain stops here: operator/system posts are depth 0, each auto-reply is parent+1.
// Without the cap, "@ada thoughts?" → "@nils agree?" → … ping-pongs two warm processes
// forever on the operator's token budget. Three hops is enough for ask → answer → close the loop.
export const BOARD_WAKE_MAX_DEPTH = 3;

// Which executives a post actually wakes: known handles only, never the author themselves.
export function mentionedExecs(mentions: string[], author: string): string[] {
  const out = new Set<string>();
  for (const h of mentions) {
    const execId = EXEC_HANDLES[h];
    if (execId && execId !== author) out.add(execId);
  }
  return [...out];
}

export function postToBoard(p: {
  author: string;
  body: string;
  thread_root_id?: string | null;
  kind?: string;
  ticket_id?: string | null;
  workspace_id?: string | null;
  /** Wake-chain depth — leave unset for operator/system posts. */
  depth?: number;
}): BoardPost {
  const post = board.create(p);
  bus.publish({
    topic: "board.posted",
    post_id: post.id,
    thread_root_id: post.thread_root_id,
    author: post.author,
    kind: post.kind,
    mentions: JSON.parse(post.mentions || "[]"),
    ticket_id: post.ticket_id,
    workspace_id: post.workspace_id,
    depth: p.depth ?? 0,
  });
  return post;
}

// The framed prompt a woken executive receives. Exported for tests and for eyeballing with
// `node -e` — prompt bugs here are invisible at runtime (they just make an exec answer oddly).
export function frameBoardWake(execId: string, post: BoardPost, thread: BoardPost[]): string {
  const ticket = post.ticket_id ? tickets.get(post.ticket_id) : undefined;
  const lines = thread
    .filter((p) => p.id !== post.id)
    .map((p) => `[${p.author}] ${p.body}`.slice(0, 1500));
  // A peer's or the daemon's @mention is the daemon talking, so it carries the operational marker
  // and never counts as the operator's turn for a recap. The operator's OWN board post is the
  // operator speaking — a marker there would make his own message invisible to "where were we".
  const op = post.author === "operator" ? "" : OP_PREFIX;
  return (
    `${op}[The board — Chronos's shared feed. You are ${EXEC_TITLE[execId] ?? execId}.]\n` +
    `${post.author === "operator" ? "the operator" : `Your peer ${post.author}`} mentioned you in a thread. ` +
    `Everything here is public to the operator and every executive — no DMs.\n` +
    `Your reply text is posted to the same thread as you. Keep it crisp; ops answers carry ticket keys.\n` +
    `You are the only executive: there is no peer to @mention. Answer it yourself or say what you need.\n` +
    (ticket ? `THREAD TICKET: ${ticket.key} — ${ticket.title}\n` : "") +
    (lines.length ? `\nTHREAD SO FAR:\n${lines.join("\n")}\n` : "") +
    `\nNEW POST by ${post.author}:\n${post.body}`
  );
}

// One seam for tests (see setExecutor in dispatcher.ts): production lazily imports the warm
// executive processes; tests inject a stub and never touch a real backend (CLAUDE.md gotcha #2).
type BoardAsker = (execId: string, text: string, wsId: string | null) => Promise<string>;
let asker: BoardAsker | null = null;
export function setBoardAsker(fn: BoardAsker | null): void {
  asker = fn;
}

async function defaultAsker(execId: string, text: string, wsId: string | null): Promise<string> {
  const a = await import("./telegram/agent.js");
  if (execId !== "robert") throw new Error(`unknown executive: ${execId}`);
  return (await a.askManagerWeb(text, undefined, wsId)).reply;
}

async function wakeExec(execId: string, e: Extract<BusEvent, { topic: "board.posted" }>): Promise<void> {
  const post = board.get(e.post_id);
  if (!post) return;
  const root = post.thread_root_id ?? post.id;
  const framed = frameBoardWake(execId, post, board.thread(root));
  try {
    const reply = (await (asker ?? defaultAsker)(execId, framed, post.workspace_id)).trim();
    if (!reply) return;
    postToBoard({
      author: execId,
      body: reply,
      thread_root_id: root,
      workspace_id: post.workspace_id,
      ticket_id: post.ticket_id,
      depth: e.depth + 1,
    });
  } catch (err: any) {
    // Depth is pinned to the cap so an error post can never wake anyone — no error loops.
    postToBoard({
      author: execId,
      body: `⚠️ ${execId} hit an error answering this thread: ${String(err?.message ?? err).slice(0, 300)}`,
      thread_root_id: root,
      workspace_id: post.workspace_id,
      depth: BOARD_WAKE_MAX_DEPTH,
    });
  }
}

export function startBoardWatcher(): void {
  bus.on("event", (e: BusEvent) => {
    if (e.topic !== "board.posted") return;
    if (e.depth >= BOARD_WAKE_MAX_DEPTH) return;
    for (const execId of mentionedExecs(e.mentions, e.author))
      void wakeExec(execId, e).catch((err) => console.error(`[board] wake ${execId} failed`, err));
  });
  console.log("[board] mention-wake watcher up");
}

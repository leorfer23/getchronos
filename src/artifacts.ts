/**
 * Artifacts — HTML pages agents publish for the operator, and the way his clicks get back to them.
 *
 * An agent writes a page (a report, a comparison, a picker, a form) and publishes it with
 * `mc artifact put|ask`. The Desk shows it in a sandboxed iframe (static/artifact-view.js); inside,
 * the page talks through `window.chronos` (static/artifact-sdk.js). What it sends back is an
 * artifact_events row, and a page that IS a question (`mc artifact ask`) is an ordinary asks row
 * underneath: its submit is the ask's answer, so everything asks already do — park and resume a run,
 * wake a waiting terminal, the Telegram card, "later" — works for pages without a second mechanism.
 *
 * Storage: `artifacts/<workspace>/<id>/v<n>.html` under the daemon's state dir (CHRONOS_ARTIFACTS
 * overrides), every version kept. The file is the page; the row is the index.
 *
 * Security: the page is the agent's HTML, so the Desk never trusts it. frameHtml() puts a CSP before
 * ANY of the page's own markup (no network except script/style/font/image CDNs, no connect, no form
 * posts), and the viewer frames it `sandbox="allow-scripts allow-forms allow-popups"` without
 * allow-same-origin — an opaque origin that cannot read the Desk's token or storage. authz.ts refuses
 * `Origin: null` the tokenless-loopback pass, so even a request that slipped out is not the operator.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifacts, asks, jobs, runs, sessions, type Artifact, type ArtifactEvent, type AskRoute } from "./store.js";
import { bus } from "./bus.js";
import { answerAsk, notifyAskCreated } from "./asks.js";
import { postRobertToDesk } from "./robert-desk.js";
import { inRepo } from "./repo-root.js";

export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_STATE_BYTES = 256 * 1024;

export const artifactRoot = (): string => process.env.CHRONOS_ARTIFACTS || inRepo("artifacts");
export const artifactFile = (a: Pick<Artifact, "id" | "workspace_id">, v: number): string =>
  path.join(artifactRoot(), a.workspace_id || "_", a.id, `v${v}.html`);

/** Alone on a line in a Robert/Desk chat row: the chat mounts the page's card there (artifact-view.js). */
export const artifactMarker = (id: string): string => `::artifact ${id}::`;
export const ARTIFACT_MARKER_RE = /^::artifact ([0-9a-f-]{8,36})::$/;

/**
 * Where the operator opens a page from anywhere — the link an agent prints. localhost is only right on
 * the brain itself: an agent on another host (HOSTS.md) printing its own loopback points at nothing.
 * CHRONOS_DESK_URL wins; else the tunnel the hosts already dial (CHRONOS_HOST_PUBLIC_URL, wss://…/host)
 * is the same public Desk over https; else this machine's loopback.
 */
export function deskBase(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.CHRONOS_DESK_URL ?? "").trim();
  if (set) return set.replace(/\/+$/, "").replace(/\/desk$/, "");
  const tunnel = (env.CHRONOS_HOST_PUBLIC_URL ?? "").split(",").map((s) => s.trim()).find(Boolean);
  if (tunnel) {
    try {
      const u = new URL(tunnel);
      if (u.protocol === "wss:" || u.protocol === "https:") return "https://" + u.host;
    } catch {}
  }
  return "http://localhost:" + Number(env.CHRONOS_PORT ?? 7777);
}
export const artifactUrl = (id: string, env: NodeJS.ProcessEnv = process.env): string => deskBase(env) + "/desk#artifact=" + id;

export class ArtifactError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function writeVersion(a: Pick<Artifact, "id" | "workspace_id">, v: number, html: string): void {
  const f = artifactFile(a, v);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, html, { mode: 0o600 });
}

export function readVersion(a: Artifact, v = a.version): string {
  if (!Number.isInteger(v) || v < 1 || v > a.version) throw new ArtifactError(`no version ${v} (latest is ${a.version})`, 404);
  try {
    return fs.readFileSync(artifactFile(a, v), "utf8");
  } catch {
    throw new ArtifactError(`version ${v} is missing on disk`, 404);
  }
}

export type PublishInput = {
  title: string;
  html: string;
  workspace_id: string | null;
  session_id?: string | null;
  run_id?: string | null;
  created_by?: string | null;
  /** Makes the page a question: an asks row whose answer is the page's submit. */
  question?: string | null;
  options?: string[] | null;
  route?: AskRoute;
  /** Put the page's card in the Desk chat even though it asks nothing. */
  notify?: boolean;
};

export async function publishArtifact(p: PublishInput): Promise<{ artifact: Artifact; ask_id: string | null }> {
  if (bytes(p.html) > MAX_HTML_BYTES) throw new ArtifactError(`page is over ${MAX_HTML_BYTES / 1024 / 1024}MB`, 413);
  const run = p.run_id ? runs.get(p.run_id) : undefined;
  const job = run ? jobs.get(run.job_id) : undefined;
  const sess = !run && p.session_id ? sessions.get(p.session_id) : undefined;
  if (p.question && !run && !sess) throw new ArtifactError("a page that asks needs the asking terminal or run", 400);

  let a = artifacts.create({
    title: p.title,
    workspace_id: p.workspace_id,
    session_id: sess?.id ?? p.session_id ?? null,
    run_id: run?.id ?? null,
    created_by: p.created_by ?? null,
  });
  writeVersion(a, 1, p.html);

  let askId: string | null = null;
  if (p.question) {
    const ask = asks.create({
      run_id: run?.id ?? null,
      job_id: run?.job_id ?? null,
      session_id: run ? null : sess!.id,
      asked_by: p.created_by ?? null,
      route: p.route ?? "operator",
      ticket_id: job?.ticket_id ?? sess?.ticket_id ?? null,
      workspace_id: p.workspace_id,
      question: p.question,
      options: p.options ?? null,
    });
    askId = ask.id;
    a = artifacts.patch(a.id, { ask_id: ask.id })!;
    // The chat gets the PAGE's card below instead of the plain ask card — same question, and the
    // page is the better way to answer it. Telegram still gets its card: the options work from there.
    void notifyAskCreated(ask, job, { desk: false }).catch((e) => console.error("[artifacts] ask notify failed", e));
  }

  bus.publish({ topic: "artifact.created", artifact_id: a.id, workspace_id: a.workspace_id, session_id: a.session_id, title: a.title, ask_id: askId });
  if ((p.question && (p.route ?? "operator") === "operator") || p.notify) postRobertToDesk({ body: artifactMarker(a.id), ws: a.workspace_id });
  return { artifact: a, ask_id: askId };
}

/** A new version of the same page. Old versions stay on disk; the viewer shows the latest. */
export function updateArtifact(a: Artifact, html: string, title?: string | null, notify = false): Artifact {
  if (bytes(html) > MAX_HTML_BYTES) throw new ArtifactError(`page is over ${MAX_HTML_BYTES / 1024 / 1024}MB`, 413);
  const v = a.version + 1;
  writeVersion(a, v, html);
  const out = artifacts.patch(a.id, { version: v, ...(title ? { title } : {}) })!;
  bus.publish({ topic: "artifact.updated", artifact_id: a.id, workspace_id: a.workspace_id, session_id: a.session_id, version: v });
  if (notify) postRobertToDesk({ body: artifactMarker(a.id), ws: a.workspace_id });
  return out;
}

const parse = (s: string | null): unknown => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return s; }
};
const encode = (data: unknown): string => JSON.stringify(data === undefined ? null : data);

function lastSubmit(a: Artifact): unknown {
  const ev = artifacts.events(a.id).filter((e) => e.kind === "submit").pop();
  return ev ? parse(ev.data) : null;
}

function publishEvent(a: Artifact, ev: ArtifactEvent): void {
  bus.publish({
    topic: "artifact.event",
    artifact_id: a.id,
    event_id: ev.id,
    kind: ev.kind,
    workspace_id: a.workspace_id,
    session_id: a.session_id,
    actor: ev.by,
  });
}

/** How an answer reads to the agent: a string as itself, anything else as JSON. */
export const answerText = (data: unknown): string => (typeof data === "string" ? data : encode(data));

/**
 * The page's answer. A page that is a question answers its ask through answerAsk — the ONE door, so
 * `ask_policy`, the resume of a parked run and the waiting terminal all behave exactly as for a typed
 * answer. Once only: a second submit (two tabs, the phone) is a 409, never a second answer.
 */
export async function submitArtifact(a: Artifact, data: unknown, by: string): Promise<{ artifact: Artifact; event: ArtifactEvent }> {
  const text = encode(data);
  if (bytes(text) > MAX_EVENT_BYTES) throw new ArtifactError("answer is too large", 413);
  if (a.ask_id) {
    const ask = asks.get(a.ask_id);
    if (!ask || ask.status !== "open" || !artifacts.markAnswered(a.id)) throw new ArtifactError(`already ${ask?.status === "cancelled" ? "cancelled" : "answered"}`, 409);
    const out = await answerAsk(ask.id, answerText(data), by);
    if (!out.ok) {
      artifacts.patch(a.id, { status: "open" });
      throw new ArtifactError(out.error, out.status ?? 409);
    }
  } else {
    artifacts.markAnswered(a.id);
  }
  const event = artifacts.addEvent(a.id, "submit", text, by);
  const fresh = artifacts.get(a.id)!;
  publishEvent(fresh, event);
  return { artifact: fresh, event };
}

/** Anything short of the answer — a pick, a draft, a thumbs-up. As many as the page likes. */
export function sendArtifact(a: Artifact, data: unknown, by: string): ArtifactEvent {
  const text = encode(data);
  if (bytes(text) > MAX_EVENT_BYTES) throw new ArtifactError("message is too large", 413);
  const ev = artifacts.addEvent(a.id, "send", text, by);
  publishEvent(a, ev);
  return ev;
}

export function setArtifactState(a: Artifact, state: unknown): Artifact {
  const text = encode(state);
  if (bytes(text) > MAX_STATE_BYTES) throw new ArtifactError("state is too large", 413);
  return artifacts.patch(a.id, { state: text })!;
}

/** Events after `after`; with none yet, waits for the next one up to `timeoutMs`. */
export function waitArtifactEvents(id: string, after: number, timeoutMs: number): Promise<ArtifactEvent[]> {
  const now = artifacts.events(id, after);
  if (now.length || timeoutMs <= 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      bus.off("event", onEvent);
      resolve(artifacts.events(id, after));
    };
    const onEvent = (e: { topic: string; artifact_id?: string }) => {
      if (e.topic === "artifact.event" && e.artifact_id === id) done();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    bus.on("event", onEvent);
  });
}

/**
 * The ask behind a page answered some other way — a Telegram button, `mc answer`, Robert. The page
 * is answered too, with that answer as its submit, so its card and `mc artifact events` agree with
 * the ask. A submit from the page itself already marked it, so this is a no-op then.
 */
export function onAskAnswered(e: { topic: string; ask_id?: string; answer?: unknown; answered_by?: unknown }): void {
  if (e.topic !== "ask.answered" || !e.ask_id) return;
  const a = artifacts.byAsk(e.ask_id);
  if (!a || !artifacts.markAnswered(a.id)) return;
  const ev = artifacts.addEvent(a.id, "submit", encode(e.answer ?? null), String(e.answered_by || "operator"));
  publishEvent(a, ev);
}
bus.on("event", onAskAnswered);

// ── the frame ───────────────────────────────────────────────────────────────────────────────────

const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";
export const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src data: https://fonts.gstatic.com ${CDNS}`,
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
].join("; ");

// The Desk's own tokens (static/desk.html :root), so a page that uses var(--ink) & co. looks like it
// belongs — and follows dark mode the same way. :where() keeps them at zero specificity.
const TOKENS =
  ":root{color-scheme:light dark;--bg:#F3F5F3;--surface:#FFFFFF;--surface-2:#EBEEEB;--ink:#1B211E;--muted:#67716B;--faint:#9AA49E;--line:#DEE3DF;--accent:#2E7D64;--accent-ink:#FFFFFF;--accent-soft:#E1EEE8;--warn:#9A6B00;--warn-soft:#F5EAD0;--danger:#B23B2E;--danger-soft:#F6E3E0;--ok:#2E7D64}" +
  "@media (prefers-color-scheme: dark){:root:not([data-theme=light]){--bg:#121614;--surface:#1B201D;--surface-2:#232925;--ink:#E6ECE8;--muted:#93A099;--faint:#6B7671;--line:#2B322E;--accent:#56B693;--accent-ink:#0D1511;--accent-soft:#1F332B;--warn:#D9A83F;--warn-soft:#33290F;--danger:#E0705F;--danger-soft:#38201C;--ok:#56B693}}" +
  ":root[data-theme=dark]{--bg:#121614;--surface:#1B201D;--surface-2:#232925;--ink:#E6ECE8;--muted:#93A099;--faint:#6B7671;--line:#2B322E;--accent:#56B693;--accent-ink:#0D1511;--accent-soft:#1F332B;--warn:#D9A83F;--warn-soft:#33290F;--danger:#E0705F;--danger-soft:#38201C;--ok:#56B693}" +
  ":where(html){background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,\"Segoe UI\",sans-serif}";

const SDK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "static", "artifact-sdk.js");
let sdkCache: { mtime: number; src: string } | null = null;
function sdkSource(): string {
  try {
    const mtime = fs.statSync(SDK_FILE).mtimeMs;
    if (!sdkCache || sdkCache.mtime !== mtime) sdkCache = { mtime, src: fs.readFileSync(SDK_FILE, "utf8") };
    return sdkCache.src;
  } catch {
    return "";
  }
}

/** JSON that is safe inside a <script>: no `</script>`, no U+2028/9 line breaks. */
const scriptJson = (v: unknown) =>
  JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export type FrameContext = {
  id: string;
  title: string;
  version: number;
  status: string;
  question: string | null;
  options: string[];
  answer: unknown;
  workspace: string | null;
  by: string | null;
  state: unknown;
};

export function frameContext(a: Artifact, v = a.version): FrameContext {
  const ask = a.ask_id ? asks.get(a.ask_id) : undefined;
  let options: string[] = [];
  try { options = ask?.options ? (JSON.parse(ask.options) as string[]) : []; } catch {}
  return {
    id: a.id,
    title: a.title,
    version: v,
    status: a.status,
    question: ask?.question ?? null,
    options,
    answer: lastSubmit(a),
    workspace: a.workspace_id,
    by: a.created_by,
    state: parse(a.state),
  };
}

/**
 * The document the viewer puts in `srcdoc`: OUR head first — charset, the CSP, the tokens, the SDK —
 * then the agent's page verbatim. Ours goes first unconditionally (never "after the page's <head>"),
 * because anything the page put before its own <head> would run before a CSP inserted there. The
 * parser folds the page's own doctype/<html>/<head> into ours: a second <head> is ignored and its
 * <title>/<style>/<meta> still land in the head.
 */
export function frameHtml(html: string, ctx: FrameContext): string {
  const head =
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${TOKENS}</style>` +
    `<script>window.__CHRONOS__=${scriptJson(ctx)};\n${sdkSource()}</script>`;
  return `<!doctype html><html><head>${head}</head>${html.replace(/^﻿?\s*<!doctype[^>]*>/i, "")}`;
}

/** What `GET /artifacts/:id` hands back: the row with its JSON parsed, and where it lives. */
export function artifactView(a: Artifact) {
  const ask = a.ask_id ? asks.get(a.ask_id) : undefined;
  return {
    ...a,
    state: parse(a.state),
    question: ask?.question ?? null,
    ask_status: ask?.status ?? null,
    answer: lastSubmit(a),
    file: artifactFile(a, a.version),
    url: artifactUrl(a.id),
  };
}

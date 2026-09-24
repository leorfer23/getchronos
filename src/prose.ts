/**
 * Operator prose — agents that write AS the operator (a Slack reply, a Jira comment, a status email)
 * should sound like him, not like a model. Per workspace, because he does not write to one client
 * the way he writes to another.
 *
 *   capture  — samples of what he actually sent (prose_samples, migration 131):
 *              · `mc prose add` — a terminal relays text he wrote, or an edit: the agent's draft
 *                (`--draft`) next to what he really sent, the strongest signal there is
 *              · connector sync — Jira/ClickUp comments whose author is the token's owner
 *              · the learn job itself pulls his recent Slack messages through the workspace's
 *                Slack MCP, when one is connected
 *   learn    — once enough new samples land, or a `comms` lesson changes (his corrections about how
 *              he wants to be talked to — they outrank anything inferred from samples), a read-only
 *              agent rewrites the `prose-guide` memo: THE voice page, one page, English, a couple of
 *              verbatim exemplars. Rewritten whole every pass, never appended to — it cannot grow.
 *   use      — every agent's system prompt carries that page once (proseBlock), where the separate
 *              comms-lessons block used to be; before drafting anything that goes out under his
 *              name it runs `mc prose --channel … --about …`, which adds the closest real samples
 *
 * Output is always English, whatever language a sample is in: the guide carries his tone, rhythm
 * and habits across, never Spanish words.
 *
 * Nothing Chronos itself posted may count as his writing — a comment pushed with his credentials is
 * still an agent's text. pushComment records a hash of every body it sends (markPushed) and the
 * harvest skips those, plus the write-back template for comments posted before this existed.
 */
import { createHash } from "node:crypto";
import { CONFIG } from "./config.js";
import { jobs, kv, lessons, notes as noteStore, repos, runs, workspaces } from "./store.js";
import { bus, type BusEvent } from "./bus.js";
import { proseSamples, PROSE_CHANNELS, type ProseChannel, type ProseOrigin, type ProseSample, type ProseSource } from "./store/prose.js";
import { createNote, updateNote } from "./notes.js";
import { dispatch } from "./dispatcher.js";
import { guard } from "./guard.js";
import { similarity } from "./text-similarity.js";
import { slackReady } from "./slack.js";
import { REPO_ROOT } from "./repo-root.js";
import type { ExternalTask } from "./connectors/types.js";
import type { Lesson, Note, Workspace } from "./types.js";

export const GUIDE_SLUG = "prose-guide";
/** One page. Enforced on save — refused, never truncated: his voice fits on a page, and stays there. */
export const GUIDE_CAP = 2500;
/** Headroom the learner is asked to leave, so a pass that runs a little long still saves. */
const GUIDE_MARGIN = 300;
/** His corrections fed to one rewrite, newest first. Older rows stay stored as evidence. */
const RULES_IN_GOAL = 25;
export const SAMPLE_CAP = 4000;
/** Shorter than this is an ack ("done", "thanks!") — no signal about how he writes. */
export const MIN_SAMPLE = 25;
const LEARN_KV = (ws: string) => `prose.learned.${ws}`;
const PUSHED_KV = (hash: string) => `prose.pushed.${hash}`;
const DIRTY_KV = (ws: string) => `prose.dirty.${ws}`;
const LEARN_EVERY_MS = 24 * 3600_000;
/** A correction earns a sooner pass than a pile of samples — still batched, never one run per rule. */
const DIRTY_EVERY_MS = 3600_000;

const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
export const proseHash = (s: string) => createHash("sha256").update(norm(s).toLowerCase()).digest("hex").slice(0, 20);

export type AddSampleInput = {
  body: string;
  channel?: string;
  source?: string;
  draft?: string | null;
  context?: string | null;
  ref?: string | null;
};

export type AddSampleResult = { ok: true; sample: ProseSample | null } | { ok: false; error: string };

const asChannel = (c: string | undefined, source: string): ProseChannel => {
  const v = (c || "").toLowerCase();
  if ((PROSE_CHANNELS as readonly string[]).includes(v)) return v as ProseChannel;
  if ((PROSE_CHANNELS as readonly string[]).includes(source)) return source as ProseChannel;
  return "other";
};

/** One sample in. `sample: null` = already held (same text, this workspace). */
export function addSample(workspace_id: string, input: AddSampleInput, origin: ProseOrigin): AddSampleResult {
  const body = (input.body || "").trim();
  if (norm(body).length < MIN_SAMPLE) return { ok: false, error: `too short to learn from (min ${MIN_SAMPLE} chars)` };
  if (body.length > SAMPLE_CAP) return { ok: false, error: `samples are capped at ${SAMPLE_CAP} chars — send the message, not the thread` };
  if (isOurs(body)) return { ok: false, error: "that text was posted by Chronos, not written by the operator" };
  const draft = input.draft?.trim() || null;
  const source = (input.source || (draft ? "edit" : "manual")).toLowerCase() as ProseSource;
  const sample = proseSamples.add({
    workspace_id,
    source,
    channel: asChannel(input.channel, source),
    origin,
    body,
    draft: draft ? draft.slice(0, SAMPLE_CAP) : null,
    context: input.context?.trim().slice(0, 1000) || null,
    ref: input.ref?.trim().slice(0, 300) || null,
    hash: proseHash(body),
  });
  return { ok: true, sample };
}

/** pushComment calls this for every body Chronos sends under the operator's credentials. */
export function markPushed(body: string): void {
  kv.set(PUSHED_KV(proseHash(body)), new Date().toISOString());
}

function isOurs(body: string): boolean {
  return !!kv.get(PUSHED_KV(proseHash(body))) || /^\s*Shipped via Chronos:/i.test(body);
}

/**
 * Tracker comments the operator wrote, into the corpus. `me` is the connector's id for the token's
 * owner (Jira accountId / ClickUp user id); without it nothing is harvested — a display-name match
 * would also catch a colleague who shares his first name.
 */
export function harvestComments(ws: Workspace, source: "jira" | "clickup", me: string | null, tasks: ExternalTask[]): number {
  if (!me) return 0;
  let added = 0;
  for (const t of tasks) {
    for (const c of t.comments) {
      if (!c.author_id || String(c.author_id) !== String(me)) continue;
      const body = (c.body || "").trim();
      if (norm(body).length < MIN_SAMPLE || body.length > SAMPLE_CAP || isOurs(body)) continue;
      const r = addSample(ws.id, { body, source, channel: source, ref: c.id ? `${source}:${t.id}#${c.id}` : `${source}:${t.id}` }, "connector");
      if (r.ok && r.sample) added++;
    }
  }
  return added;
}

export function proseGuide(workspace_id: string): Note | undefined {
  return noteStore.bySlug(workspace_id, GUIDE_SLUG);
}

export function saveGuide(workspace_id: string, body: string): { ok: true; note: Note } | { ok: false; error: string } {
  const text = (body || "").trim();
  if (!text) return { ok: false, error: "empty guide" };
  if (text.length > GUIDE_CAP) return { ok: false, error: `the voice page is capped at ${GUIDE_CAP} chars — one page (got ${text.length}). Rewrite it shorter: merge, don't append` };
  const cur = proseGuide(workspace_id);
  const note = cur ? updateNote(cur.id, { body: text }) : createNote({ workspace_id, title: "Prose guide", body: text });
  if (note.slug !== GUIDE_SLUG) return { ok: false, error: `prose guide slug collision: ${note.slug}` };
  return { ok: true, note };
}

/**
 * What `mc prose` prints: the guide, then the real samples closest to what is being written — same
 * channel first, edits first among equals (they show the gap between how a model writes and how he
 * does). Every body is guarded: samples are external text on their way into an agent's context.
 */
export function proseBrief(workspace_id: string, opts: { channel?: string; about?: string; limit?: number } = {}): string {
  const guide = proseGuide(workspace_id);
  const all = proseSamples.list(workspace_id);
  if (!guide && !all.length)
    return "No prose learned for this workspace yet. Write plainly and briefly in English, and ask the operator for a message he sent to learn from (`mc prose add`).";
  const channel = opts.channel?.toLowerCase();
  const about = opts.about || "";
  const score = (s: ProseSample) =>
    (channel && s.channel === channel ? 2 : 0) + (s.draft ? 0.5 : 0) + (about ? similarity(about, s.body) * 3 : 0) + (s.origin === "agent" ? -0.25 : 0);
  const picks = [...all].sort((a, b) => score(b) - score(a) || b.created_at.localeCompare(a.created_at)).slice(0, opts.limit ?? 4);
  const clip = (s: string, n = 700) => (s.length > n ? s.slice(0, n) + "…" : s);
  let out = "Write as the operator — in English, always, even when his samples are in another language.";
  out += guide
    ? `\n\n# ${guide.title} (${guide.slug})\n${guard(guide.body.trim(), "prose-guide", workspace_id)}`
    : "\n\n(No guide learned yet — go by the samples below.)";
  if (picks.length) {
    out += `\n\n# Closest real messages he sent${channel ? ` (channel: ${channel})` : ""}`;
    for (const s of picks) {
      out += `\n\n— ${s.channel}${s.source !== s.channel ? ` via ${s.source}` : ""}:`;
      if (s.draft) out += `\nAn agent drafted:\n${guard(clip(s.draft), "prose-sample", workspace_id)}\nHe sent instead:`;
      out += `\n${guard(clip(s.body), "prose-sample", workspace_id)}`;
    }
  }
  return out;
}

const POINTER =
  "Writing AS the operator — any Slack message, Jira/ClickUp comment, email or doc that goes out under his name: " +
  "run `mc prose --channel <slack|jira|clickup|email|doc> --about \"<gist>\"` first and match it. Always in English. " +
  "If he rewrites your draft, save the pair: `mc prose add --channel <c> --draft \"<yours>\" \"<what he sent>\"`.";
export const VOICE_HEADING =
  "## Voice — how the operator writes, and how he wants to be talked to (one page, rewritten from his own writing and corrections; follow it)";

/**
 * The voice section of every agent's system prompt — exactly one, the page (≤ GUIDE_CAP) plus a fixed
 * heading and pointer. Samples but no page yet: the pointer alone. A page over the cap (saved before the
 * cap came down) is never cut mid-rule: agents get the pointer and a note, and learnDue queues the
 * rewrite that brings it back to one page.
 */
export function proseBlock(workspace_id: string): string {
  const body = proseGuide(workspace_id)?.body.trim() ?? "";
  if (!body) return proseSamples.countSince(workspace_id, null) > 0 ? POINTER : "";
  if (body.length > GUIDE_CAP)
    return `${POINTER}\nHis voice page is over its one-page cap and is being rewritten — read it with \`mc prose\` before you write to or as him.`;
  return `${VOICE_HEADING}\n${guard(body, "prose-guide", workspace_id)}\n\n${POINTER}`;
}

// ── corrections ──────────────────────────────────────────────────────────────────────────────────

/** His standing `comms` corrections here, newest first — the rewrite's strongest input. */
export function commsRules(workspace_id: string): Lesson[] {
  return lessons
    .list({ workspace_id, state: "active" })
    .filter((l) => l.topic === "comms")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** A comms rule landed, changed or left: the page no longer says everything he has told us. */
export function markVoiceDirty(workspace_id: string): void {
  kv.set(DIRTY_KV(workspace_id), new Date().toISOString());
}

// Lessons publish on every create/reinforce/edit/delete/decay; one that is (or was) an active comms
// rule is what the page is built from. A proposed rule is not his word yet.
bus.on("event", (e: BusEvent) => {
  if (e.topic === "lesson.updated" && e.lesson_topic === "comms" && e.state !== "proposed") markVoiceDirty(e.workspace_id);
});

// ── learning ──────────────────────────────────────────────────────────────────────────────────────

export function learnGoal(ws: Workspace, withSlack: boolean): string {
  const rules = commsRules(ws.id).slice(0, RULES_IN_GOAL);
  const samples = proseSamples.countSince(ws.id, null);
  const cur = proseGuide(ws.id)?.body.trim().length ?? 0;
  return (
    `VOICE PAGE (read-only — you change ONE memo, through the mc CLI only). ` +
    `Rewrite the operator's voice page for the "${ws.name}" workspace: how he writes, so agents drafting on his behalf sound like him, ` +
    `and how he wants agents to write TO him. Every agent here carries it in its prompt, so it stays ONE page.\n\n` +
    (withSlack
      ? `0. Slack is connected here. With the Slack MCP tools, search for messages the AUTHENTICATED USER sent in the last 60 days ` +
        `(e.g. query \`from:me\`). Keep up to 40 substantive ones (skip one-word acks, links alone, bot text) and add each VERBATIM: ` +
        `\`mc prose add --channel slack --source slack --ref "<permalink or ts>" "<text>"\` (pipe long ones on stdin). ` +
        `Only his own messages — never a colleague's. If the tools fail, skip this step.\n`
      : "") +
    (rules.length
      ? `1. His own corrections about how to talk to him — they OUTRANK anything you infer from samples. Every one that still stands goes ` +
        `into the page (merged and deduplicated, in your words, meaning kept); where two conflict, the newer one (listed first) wins:\n` +
        rules.map((l) => `- ${guard(l.rule, "comms-lesson", ws.id)}${l.scope ? ` (applies to ${l.scope})` : ""}`).join("\n") +
        "\n"
      : `1. He has recorded no corrections about how to talk to him here yet.\n`) +
    (samples || withSlack
      ? `2. Read the corpus: \`mc prose samples --json\`. origin=operator/connector is his own text; origin=agent was relayed by a terminal — trust it slightly less. ` +
        `A sample with a "draft" is an edit: the draft is what an agent wrote, the body is what he sent — study that gap hardest.\n`
      : `2. There are no samples of his writing yet — build the page from his corrections alone, and say so in one line at the top.\n`) +
    `3. Read the current page, if any: \`mc memo get ${GUIDE_SLUG}\`` +
    (cur > GUIDE_CAP ? ` (it is ${cur} chars, over the ${GUIDE_CAP} cap — condense it hard)` : "") +
    `. Keep what still holds, fix what the evidence contradicts, DROP anything stale.\n` +
    `4. Rewrite the WHOLE page — never append to the old one, never keep a changelog — IN ENGLISH, ≤${GUIDE_CAP - GUIDE_MARGIN} chars ` +
    `(${GUIDE_CAP} is a hard cap: a longer page is refused, not trimmed), and save it: \`mc prose guide --body - <<'EOF' … EOF\`.\n\n` +
    `The page is instructions to another model, concrete enough to imitate — not adjectives. A couple of tight paragraphs or short bullets, ` +
    `only what the evidence supports:\n` +
    `- Talking TO him: what he wants first, how long, what to leave out — his corrections above live here.\n` +
    `- Writing AS him: register and length (quote numbers — "2–4 short sentences"), openings and closings, structure (bullets, emoji, ` +
    `capitalisation), how he asks, pushes back, gives status; phrases he uses, and model phrases he never does; per-channel differences only where real.\n` +
    `- Language: output is ALWAYS English. If he wrote in another language, carry over tone and rhythm, never the words.\n` +
    `- End with "## Exemplars": 1–2 SHORT verbatim English samples that best show the voice (trim, never rewrite). None if he has no English samples.\n\n` +
    `Never include secrets, customer data, names of people outside the team, or anything from another workspace. ` +
    `If there are fewer than 5 usable samples, write only what the evidence supports and say so in one line at the top.`
  );
}

/** A prose job for this workspace still running or queued — never stack a second one. */
function learning(ws: Workspace): boolean {
  return jobs.list().some((j) => j.name === `prose:${ws.slug}` && runs.list(j.id).some((r) => r.status === "running" || r.status === "queued"));
}

/**
 * Due when the page has fallen behind its evidence: `minNew` fresh samples (at most once a day), a
 * comms correction newer than the last pass (at most once an hour — a burst of corrections folds into
 * one rewrite), or a page over the cap (once a day, so a pass that fails to condense it can't loop).
 */
export function learnDue(ws: Workspace, now = Date.now()): boolean {
  const last = kv.get(LEARN_KV(ws.id)) ?? null;
  const since = last ? now - Date.parse(last) : Infinity;
  const dirty = kv.get(DIRTY_KV(ws.id)) ?? null;
  const evidence = () => commsRules(ws.id).length > 0 || proseSamples.countSince(ws.id, null) > 0;
  if (dirty && (!last || dirty > last) && since >= DIRTY_EVERY_MS && evidence()) return true;
  if (since < LEARN_EVERY_MS) return false;
  if ((proseGuide(ws.id)?.body.trim().length ?? 0) > GUIDE_CAP && evidence()) return true;
  return proseSamples.countSince(ws.id, last) >= CONFIG.prose.minNew;
}

/** Dispatch the read-only learner for one workspace. Returns the job id, or an error to show. */
export function startLearning(ws: Workspace): { ok: true; job_id: string } | { ok: false; error: string } {
  if (learning(ws)) return { ok: false, error: "a prose pass is already running for this workspace" };
  const withSlack = slackReady(ws);
  if (!withSlack && !proseSamples.countSince(ws.id, null) && !commsRules(ws.id).length)
    return { ok: false, error: "no samples, no comms lessons and no Slack connected — add a few with `mc prose add` first" };
  kv.set(LEARN_KV(ws.id), new Date().toISOString());
  const job = jobs.create({
    name: `prose:${ws.slug}`,
    description: `Rewrite the operator's voice page for ${ws.name}`,
    goal: learnGoal(ws, withSlack),
    workspace_id: ws.id,
    // Imitating a voice is judgment, not a text merge — pinned to claude so the model name is valid.
    backend: "claude-code",
    model: CONFIG.prose.model,
    cwd: repos.list(ws.id)[0]?.path || REPO_ROOT,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });
  dispatch(job.id, `prose:${ws.slug}`);
  return { ok: true, job_id: job.id };
}

/** Monitor tick: rewrite any workspace's voice page that fell behind its samples or his corrections. */
export function maybeLearnProse(): void {
  if (!CONFIG.prose.auto) return;
  for (const ws of workspaces.list()) {
    if (ws.archived) continue;
    try {
      if (learnDue(ws) && !learning(ws)) {
        const r = startLearning(ws);
        if (r.ok) console.log(`[prose] ${ws.slug}: learning from new samples`);
      }
    } catch (e) {
      console.error(`[prose] ${ws.slug} failed`, e);
    }
  }
}

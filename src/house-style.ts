/**
 * House style — how a workspace's dashboards, reports and pages should look and read. Quality over
 * quantity: fewer charts, each one earning its place, the story first. Per workspace, because one
 * client's brand is not another's.
 *
 *   source  — what the workspace's OWN profile and repos already say (style-sources.ts: a dataviz or
 *             brand skill, a report template, a style guide in a repo). Registered as its style
 *             source; nothing is copied anywhere.
 *   page    — memo `house-style` (not ★: it matters only when a deliverable is visual). When the
 *             workspace has no source of its own, Chronos creates it from a strong generic default
 *             (DEFAULT_STYLE). Refined from the deliverables the operator approved and from his
 *             corrections by a learner that rewrites the WHOLE page — one page, never appended to.
 *   use     — one pointer line in every agent's context (styleBlock) and `mc style --kind
 *             dashboard|report|artifact`, the same pattern `mc prose` uses for Slack. The visual
 *             critic (visual-critic.ts) judges every visual hand-off against the same text.
 *
 * The wall: everything here is keyed by one workspace and read only from that workspace's own
 * profile, repos and memos. Nothing in another workspace's prompt, page or critic run comes from here.
 */
import { CONFIG } from "./config.js";
import { bus, type BusEvent } from "./bus.js";
import { guard } from "./guard.js";
import { dispatch } from "./dispatcher.js";
import { createNote, updateNote } from "./notes.js";
import { REPO_ROOT } from "./repo-root.js";
import { jobs, kv, notes as noteStore, repos, runs, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { registeredSources, sourceExcerpts, type StyleSource } from "./style-sources.js";
import type { Note, Workspace } from "./types.js";

export const STYLE_SLUG = "house-style";
/** One page. Enforced on save — refused, never truncated. */
export const STYLE_CAP = 3000;
const STYLE_MARGIN = 300;
export const STYLE_KINDS = ["dashboard", "report", "artifact"] as const;
export type StyleKind = (typeof STYLE_KINDS)[number];

// ───────────────────────────── the bar and the default ─────────────────────────────

/** The floor every visual deliverable is held to, in every workspace. The critic's rubric. */
export const RUBRIC =
  "## The bar every dashboard, report and page is checked against (every workspace)\n" +
  "1. Story first: the headline answer to what he asked comes first, then the drivers, then the detail.\n" +
  "2. One question per chart, and every chart earns its place. A chart that answers nothing he asked, repeats another or cannot be read is REMOVED — fewer, better charts.\n" +
  "3. Titles state the takeaway (\"Churn doubled in March, all in annual plans\"), not the field names (\"Churn by month\").\n" +
  "4. One palette and one number format per metric across the page; units and the date range stated.\n" +
  "5. Readable on a phone (390 px): no sideways scroll, no clipped labels, no text under 12 px.\n" +
  "6. No chart junk: no 3D, heavy gridlines, decoration, dual axes or crowded pies.\n" +
  "7. Every number traceable to its query or source.";

/** What the page starts as when the workspace has no style of its own. ≤ STYLE_CAP. */
export const DEFAULT_STYLE = `# House style — dashboards, reports, pages

Seeded from Chronos's default because this workspace has no style guide of its own. Rewritten from the operator's approvals and corrections; one page.

## Story first
- Open with the headline: the answer to his question in one sentence, with the number.
- Then the drivers (why), then the detail. End with what to do next when there is a decision.
- Every chart answers ONE question. Cut a chart that answers none, repeats another or needs a legend hunt.

## Titles and text
- Chart titles state the conclusion ("Signups up 18% since the new pricing page"), never the field names.
- Annotate the point that matters: a label on the spike, a line for the target. Label lines directly.
- Plain words; spell out an abbreviation once.

## Charts
- Bars to compare categories (sorted; horizontal when labels are long), lines for time, a table when exact values matter. No pie over 3 slices, no 3D, no dual axes, no gauges.
- One accent colour for what to look at, the rest muted grey. The same metric keeps the same colour everywhere.
- Bar axes start at zero. Show the comparison that gives a number meaning (vs last period, vs target).
- No chart junk: no heavy gridlines, borders, shadows, gradients or decorative icons.

## Numbers
- One format per metric: thousands separators, at most one decimal for %, units in the title or axis. Round to what matters (1.2M, not 1,234,567).
- Every number is traceable: the query, table or source behind it in a footnote, tooltip or appendix.
- State the date range and time zone once, near the top.

## Phone
- Readable at 390 px: no sideways scrolling, text 12 px or more, tap targets 40 px or more.
- KPI tiles stack two-up, charts go full width, a wide table becomes a ranked list or scrolls inside its own box.

## Before the hand-off
- Look at it at desktop and phone width (\`mc browser run\`), then cut one more thing.`;

/** What a kind of deliverable adds to the page. */
export const KIND_NOTES: Record<StyleKind, string> = {
  dashboard:
    "## A dashboard\n" +
    "- Top row: 3–5 KPI tiles that answer his question — the value, the change against a stated baseline, a sparkline only when the trend matters.\n" +
    "- Then 2–4 driver charts that explain the tiles, then the detail table. Nothing below the table.\n" +
    "- Filters only for cuts he actually uses; the default view answers the question without touching one.\n" +
    "- Interactive where it pays: tooltips with exact values, a date range, a drill from a chart to its rows.",
  report:
    "## A report\n" +
    "- The answer in the first two lines, with the number. Then 2–4 findings, each one chart whose title states it and a one-line caption saying what to notice.\n" +
    "- Then what to do next. Method, queries and caveats go in an appendix, not in the story.\n" +
    "- Anything that does not support the headline or the next step is cut.",
  artifact:
    "## A page (artifact)\n" +
    "- One self-contained HTML page: data embedded, no fetches at view time, scripts and fonts only from allowed CDNs.\n" +
    "- Mobile first: works at 390 px without sideways scroll; a wide table scrolls inside its own box.\n" +
    "- Legible in light and dark (use the page's theme tokens), and the source of every number in a footnote or details block.",
};

export const asKind = (k: unknown): StyleKind => (STYLE_KINDS as readonly string[]).includes(String(k)) ? (k as StyleKind) : "dashboard";

/**
 * The one line every agent's context carries (skills.ts agentContext). Static — no disk or store read
 * at spawn — and the same in every workspace: the workspace's own style is behind the command.
 */
export const STYLE_POINTER =
  "Building a dashboard, report, chart or page (an artifact, a deck, an HTML/PDF export)? Run `mc style --kind dashboard|report|artifact` first and follow it — this workspace's house style. " +
  "At hand-off a critic renders what you link at desktop and phone width, checks it against that style, and can send back fixes or ask you to remove charts.";
export function styleBlock(_workspaceId?: string | null): string {
  return STYLE_POINTER;
}

// ───────────────────────────── the page ─────────────────────────────

export function styleGuide(workspaceId: string): Note | undefined {
  return noteStore.bySlug(workspaceId, STYLE_SLUG);
}

export function saveStyleGuide(workspaceId: string, body: string): { ok: true; note: Note } | { ok: false; error: string } {
  const text = (body || "").trim();
  if (!text) return { ok: false, error: "empty page" };
  if (text.length > STYLE_CAP) return { ok: false, error: `the house style is capped at ${STYLE_CAP} chars — one page (got ${text.length}). Rewrite it shorter: merge, don't append` };
  const cur = styleGuide(workspaceId);
  const note = cur ? updateNote(cur.id, { body: text }) : createNote({ workspace_id: workspaceId, title: "House style", slug: STYLE_SLUG, body: text });
  if (note.slug !== STYLE_SLUG) return { ok: false, error: `house style slug collision: ${note.slug}` };
  return { ok: true, note };
}

/**
 * The workspace's style, made sure of: its registered sources and its page. A workspace with no
 * source of its own and no page gets the default page now — the only time Chronos writes one itself.
 */
export function ensureStyle(ws: Workspace, o: { rescan?: boolean } = {}): { sources: StyleSource[]; page: Note | undefined; created: boolean } {
  const sources = registeredSources(ws, { rescan: o.rescan }).sources;
  let page = styleGuide(ws.id);
  let created = false;
  if (!page && !sources.length) {
    const r = saveStyleGuide(ws.id, DEFAULT_STYLE);
    if (r.ok) { page = r.note; created = true; }
  }
  return { sources, page, created };
}

const sourceLine = (s: StyleSource): string => {
  const how = s.kind === "repo-doc" ? `read it: ${s.path}` : `load the skill (Skill tool: ${s.name}) — ${s.path}`;
  return `- ${s.kind === "repo-doc" ? "document" : "skill"} \`${s.name}\` (${s.where})${s.desc ? `: ${s.desc}` : ""} — ${how}`;
};

/**
 * What `mc style --kind <k>` prints: the bar, what this kind adds, this workspace's own sources and
 * its page, and how the hand-off is checked. Every body is guarded on its way into an agent.
 */
export function styleBrief(ws: Workspace, o: { kind?: string; rescan?: boolean } = {}): string {
  const kind = asKind(o.kind);
  const { sources, page } = ensureStyle(ws, { rescan: o.rescan });
  const parts = [`# House style — ${ws.name} · ${kind}`, RUBRIC, KIND_NOTES[kind]];
  if (sources.length) {
    parts.push(
      "## This workspace's own style — follow it first (found in its profile and repos)\n" +
      "Where it is specific (brand, palette, fonts, templates) it wins; the bar above is the floor.\n" +
      sources.map(sourceLine).join("\n"),
    );
  }
  if (page?.body.trim()) {
    parts.push(`## House style page (memo ${STYLE_SLUG})\n${guard(page.body.trim(), "house-style", ws.id)}`);
  } else if (sources.length) {
    parts.push(`(No house style page yet: the sources above are the style. His corrections land in memo ${STYLE_SLUG}.)`);
  }
  parts.push(
    "## How it is checked\n" +
    "When you hand off (`mc outcome`), Chronos renders each page, dashboard or document you link — and every `mc artifact` page you published — at desktop and phone width, and a critic reads it against all of the above. " +
    "Fixes come back to you as a rework round; it can ask for charts to be removed. Behind a login the shared browser does not have (Hex, Looker, a private doc)? " +
    "Attach what it looks like: `mc outcome … --shot dashboard-desktop=a.png --shot dashboard-phone=b.png` (or publish it as `mc artifact put`). " +
    "He corrected how something should look? Save his words: `mc style add \"<what he said>\"`.",
  );
  return parts.join("\n\n");
}

/** The style a critic judges against: the page and each source's own words (bounded), for this workspace only. */
export function styleForCritic(ws: Workspace): { text: string; label: string } {
  const { sources, page } = ensureStyle(ws);
  const parts: string[] = [];
  if (sources.length) {
    const bodies = sourceExcerpts(ws, sources, 2500);
    let budget = 7000;
    for (const s of sources) {
      const body = bodies.get(s.path);
      const head = `### ${s.kind === "repo-doc" ? "Document" : "Skill"} ${s.name} (${s.where})${s.desc ? `: ${guard(s.desc, "house-style-source", ws.id)}` : ""} — ${s.path}`;
      const piece = `${head}\n${body ? guard(body, "house-style-source", ws.id) : "(not readable now)"}`;
      if (piece.length > budget) { parts.push(`### ${s.name} (${s.where}) — ${s.path} (read it for the rest)`); continue; }
      parts.push(piece);
      budget -= piece.length;
    }
  }
  if (page?.body.trim()) parts.push(`### House style page (memo ${STYLE_SLUG})\n${guard(page.body.trim(), "house-style", ws.id)}`);
  const label = [...sources.map((s) => `${s.name}`), ...(page ? [STYLE_SLUG] : [])].join(" + ") || "the default bar";
  return { text: parts.join("\n\n") || "(this workspace has no style of its own — judge against the bar alone)", label };
}

// ───────────────────────────── what it learns from ─────────────────────────────

/** A correction he gave about how something should look, or a visual deliverable he approved. */
export type StyleNote = {
  id: string;
  at: string;
  kind: "correction" | "approved";
  text: string;
  /** operator = his own words first-hand (his shell, his decision); agent = a terminal relaying them. */
  origin: "operator" | "agent";
  ref: string | null;
};
const NOTES_KV = (ws: string) => `style.notes.${ws}`;
const LEARNED_KV = (ws: string) => `style.learned.${ws}`;
/** Kept per workspace, newest last. Older ones fall off: by then the page carries what they said. */
const MAX_NOTES = 60;
export const NOTE_CAP = 800;

export function styleNotes(workspaceId: string): StyleNote[] {
  try {
    const v = JSON.parse(kv.get(NOTES_KV(workspaceId)) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function addStyleNote(workspaceId: string, n: { kind?: StyleNote["kind"]; text: string; origin: StyleNote["origin"]; ref?: string | null }, now = new Date()): { ok: true; note: StyleNote | null } | { ok: false; error: string } {
  const text = String(n.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 8) return { ok: false, error: "too short to learn from — say what should change and how" };
  if (text.length > NOTE_CAP) return { ok: false, error: `a note is capped at ${NOTE_CAP} chars — the rule, not the thread` };
  const all = styleNotes(workspaceId);
  if (all.some((x) => x.text.toLowerCase() === text.toLowerCase())) return { ok: true, note: null };
  const note: StyleNote = { id: Math.random().toString(36).slice(2, 10), at: now.toISOString(), kind: n.kind ?? "correction", text, origin: n.origin, ref: n.ref ?? null };
  kv.set(NOTES_KV(workspaceId), JSON.stringify([...all, note].slice(-MAX_NOTES)));
  return { ok: true, note };
}

/** Did this request deliver something visual — a page, a dashboard, a document — or carry a critic's verdict? */
function wasVisual(requestId: string): boolean {
  if (requests.deliverables(requestId).some((d) => d.kind === "artifact" || d.kind === "dashboard" || d.kind === "doc")) return true;
  return requests.checks(requestId).some((c) => c.name === "visual");
}

/**
 * His answer on a visual hand-off is the strongest signal there is: a "change" carries his words
 * about it, a "yes" says what he accepts. Both feed the next rewrite of that workspace's page only.
 */
export function onStyleDecision(e: { request_id?: string; item_id?: string; workspace_id?: string | null; decision?: string }): void {
  if (!e.request_id || !e.item_id || !e.workspace_id) return;
  if (e.decision !== "change" && e.decision !== "yes") return;
  const r = requests.get(e.request_id);
  if (!r || r.workspace_id !== e.workspace_id || !wasVisual(r.id)) return;
  const item = requests.item(e.item_id);
  if (!item || item.request_id !== r.id) return;
  if (e.decision === "change") {
    if (item.words?.trim()) addStyleNote(r.workspace_id, { kind: "correction", text: item.words.slice(0, NOTE_CAP), origin: "operator", ref: r.id });
    return;
  }
  const visual = requests.checks(r.id).filter((c) => c.name === "visual").pop();
  const what = requests.deliverables(r.id).filter((d) => d.kind === "artifact" || d.kind === "dashboard" || d.kind === "doc").map((d) => d.label || d.ref).slice(0, 3).join(", ");
  const text = `He approved ${what || item.label}${visual?.status === "pass" && visual.note ? ` — the critic saw: ${visual.note}` : ""}`;
  addStyleNote(r.workspace_id, { kind: "approved", text: text.slice(0, NOTE_CAP), origin: "operator", ref: r.id });
}

bus.on("event", (e: BusEvent) => {
  if (e.topic !== "ledger.decided") return;
  try { onStyleDecision(e as any); } catch (err: any) { console.warn("[style] learning from a decision:", err?.message ?? err); }
});

// ───────────────────────────── the rewrite ─────────────────────────────

/** Notes newer than the last pass. */
export function newNotes(workspaceId: string): StyleNote[] {
  const last = kv.get(LEARNED_KV(workspaceId)) ?? "";
  return styleNotes(workspaceId).filter((n) => n.at > last);
}

const HOUR = 3600_000;
/**
 * Due when the page has fallen behind what he said: a correction newer than the last pass (at most
 * hourly — a burst folds into one rewrite), or three approvals (at most daily).
 */
export function styleLearnDue(ws: Workspace, now = Date.now()): boolean {
  const last = kv.get(LEARNED_KV(ws.id));
  const since = last ? now - Date.parse(last) : Infinity;
  const fresh = newNotes(ws.id);
  if (fresh.some((n) => n.kind === "correction") && since >= HOUR) return true;
  return fresh.filter((n) => n.kind === "approved").length >= 3 && since >= 24 * HOUR;
}

export function styleLearnGoal(ws: Workspace): string {
  const { sources, page } = { sources: registeredSources(ws).sources, page: styleGuide(ws.id) };
  const all = styleNotes(ws.id);
  const corrections = all.filter((n) => n.kind === "correction").reverse().slice(0, 30);
  const approved = all.filter((n) => n.kind === "approved").reverse().slice(0, 12);
  const cur = page?.body.trim().length ?? 0;
  return (
    `HOUSE STYLE PAGE (read-only — you change ONE memo, through the mc CLI only). ` +
    `Rewrite the house style page for the "${ws.name}" workspace: how its dashboards, reports and pages should look and read. ` +
    `Every agent here reads it before building one (\`mc style\`) and a critic judges every visual hand-off against it, so it stays ONE page.\n\n` +
    (sources.length
      ? `0. This workspace's OWN style sources come first — do NOT restate them; the page adds only what they do not say (his corrections, what he approved):\n` +
        sources.map((s) => `- ${s.kind === "repo-doc" ? "document" : "skill"} ${s.name} (${s.where}) — ${s.path}`).join("\n") + "\n"
      : `0. It has no style source of its own: the page IS its house style. Keep the substance of the current page unless the evidence below says otherwise.\n`) +
    (corrections.length
      ? `1. His corrections, newest first — they OUTRANK everything. Keep only what is about form (layout, charts, titles, numbers, colours, length, phone); ` +
        `every one that still stands goes into the page, merged and deduplicated, meaning kept; where two conflict the newer wins:\n` +
        corrections.map((n) => `- ${n.origin === "agent" ? "(relayed by a terminal) " : ""}${guard(n.text, "house-style-note", ws.id)}`).join("\n") + "\n"
      : `1. He has given no corrections about form here yet.\n`) +
    (approved.length
      ? `2. Deliverables he approved, and what the critic saw in them — keep what made them work:\n` +
        approved.map((n) => `- ${guard(n.text, "house-style-note", ws.id)}`).join("\n") + "\n"
      : "") +
    `3. Read the current page: \`mc memo get ${STYLE_SLUG}\`` + (cur ? ` (${cur} chars)` : " (there is none yet)") +
    `. Keep what still holds, fix what the evidence contradicts, drop what is stale.\n` +
    `4. Rewrite the WHOLE page — never append, never a changelog — in English, ≤${STYLE_CAP - STYLE_MARGIN} chars (${STYLE_CAP} is a hard cap: longer is refused, not trimmed), ` +
    `and save it: \`mc style guide --body - <<'EOF' … EOF\`.\n\n` +
    `Write instructions another model can check a page against: numbers, formats, named chart types, what comes first — not adjectives. ` +
    `Never include customer data, names of people, or anything from another workspace.`
  );
}

/** A style pass for this workspace running or queued — never stack a second one. */
function learning(ws: Workspace): boolean {
  return jobs.list().some((j) => j.name === `style:${ws.slug}` && runs.list(j.id).some((r) => r.status === "running" || r.status === "queued"));
}

export function startStyleLearning(ws: Workspace): { ok: true; job_id: string } | { ok: false; error: string } {
  if (learning(ws)) return { ok: false, error: "a house style pass is already running for this workspace" };
  if (!styleNotes(ws.id).length) return { ok: false, error: "nothing to learn from yet — save his corrections with `mc style add` first" };
  kv.set(LEARNED_KV(ws.id), new Date().toISOString());
  const job = jobs.create({
    name: `style:${ws.slug}`,
    description: `Rewrite the house style page for ${ws.name}`,
    goal: styleLearnGoal(ws),
    workspace_id: ws.id,
    backend: "claude-code",
    model: process.env.CHRONOS_STYLE_MODEL || CONFIG.prose.model,
    cwd: repos.list(ws.id)[0]?.path || REPO_ROOT,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  } as any);
  dispatch(job.id, `style:${ws.slug}`);
  return { ok: true, job_id: job.id };
}

/** Monitor tick: rewrite any workspace's page that fell behind what he said. */
export function maybeLearnStyle(): void {
  if (process.env.CHRONOS_STYLE_LEARN === "0") return;
  for (const ws of workspaces.list()) {
    if (ws.archived) continue;
    try {
      if (styleLearnDue(ws) && !learning(ws)) {
        const r = startStyleLearning(ws);
        if (r.ok) console.log(`[style] ${ws.slug}: rewriting the house style from new corrections/approvals`);
      }
    } catch (e) {
      console.error(`[style] ${ws.slug} failed`, e);
    }
  }
}

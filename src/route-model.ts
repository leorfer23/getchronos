/**
 * The thread router's judgment: a cheap model (haiku, one shot) reads the message together with
 * everything the operator's screen knows — the projects, the terminals that are open and what each
 * is doing, the last few lines of the thread and where they landed — and says which project's Robert
 * should answer. The deterministic rules in thread-router.ts are not thrown away: an explicit #tag is
 * still final, and every other rule (ticket key, repo/project name, fleet wording, the sticky
 * project, the terminal on screen) goes into this prompt as a HINT the model weighs, not a verdict.
 *
 * Isolation is unchanged: this call only picks a workspace id. It runs on the operator's own profile,
 * its prompt is thrown away, and no workspace's Robert ever sees another's terminals through it.
 *
 * Any failure — model off, timeout, unparseable answer — returns null and the caller falls back to
 * the rules, so routing never gets worse than it was.
 */
import { CONFIG } from "./config.js";
import { chat, repos, sessions, workspaces } from "./store.js";
import { noteHelperCall } from "./helper-spend.js";
import { oneShotText } from "./summarize.js";
import { tokens } from "./text-similarity.js";
import type { Workspace } from "./types.js";

export type RouteHints = {
  signals: Array<{ why: string; workspaces: string[] }>; // slugs
  fleetIntent: boolean;
  social: boolean;
  sticky: { slug: string | null; minutesAgo: number } | null;
  staged: string | null; // slug of the terminal on screen
};

export type ModelRoute = {
  /** A workspace id, null = the whole shop, "ask" = the model cannot tell. */
  ws: string | null | "ask";
  confidence: number;
  why: string;
  /** Slugs the model thinks are the likely ones, best first — the order of an ask line. */
  candidates: string[];
};

type Ask = (prompt: string) => Promise<string | null>;

let override: Ask | null = null;
/** Tests (and nothing else) swap the model for a stub. null restores the real one. */
export function setRouteModel(fn: Ask | null): void {
  override = fn;
}

/** Off in tests unless a stub is installed, and off when CHRONOS_THREAD_ROUTER_MODEL=off. */
export function routeModelEnabled(): boolean {
  if (override) return true;
  if (process.env.CHRONOS_TEST) return false;
  return CONFIG.thread.routerModel !== "off";
}

const clip = (s: string | null | undefined, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** The prompt, built from the store. Exported so a test can read what the model is shown. */
export function routePrompt(text: string, hints: RouteHints): string {
  const ws = workspaces.list().filter((w) => !(w as any).archived);
  const slug = (id: string | null) => (id ? workspaces.get(id)?.slug ?? "?" : "all");
  const repoNames = (w: Workspace) => repos.list(w.id).map((r) => r.name).slice(0, 8).join(", ");
  const projects = ws.map((w) => `- ${w.slug}: ${w.name}${repoNames(w) ? ` · repos: ${repoNames(w)}` : ""}`).join("\n");

  // Workspaces never mix: this prompt names projects and counts, never what any client's terminal or
  // conversation says. Which project a terminal or an id belongs to is matched in code (the hints).
  const live = sessions.list({ status: "live", limit: 200 });
  const counts = new Map<string, number>();
  for (const s of live) counts.set(slug(s.workspace_id), (counts.get(slug(s.workspace_id)) ?? 0) + 1);
  const terms = [...counts.entries()].map(([sl, n]) => `- ${sl}: ${n} open`).join("\n");

  const recent = chat.recentAll(8)
    .filter((m: any) => m.source !== "divider" && (m.you || m.reply))
    .slice(-6)
    .map((m: any) => slug(m.workspace_id ?? null))
    .join(" → ");

  const h: string[] = [];
  for (const s of hints.signals) h.push(`- ${s.why} → ${s.workspaces.join(" or ")}`);
  // Topic matching happens HERE, in code: which project's open terminals or recent messages share
  // words with this one. Only the project and a count reach the model — never the matched text.
  for (const t of topicMatches(text, live)) h.push(`- its words match ${t.what} in ${t.slug} (${t.shared} words in common)`);
  if (hints.fleetIntent) h.push("- the wording reads like a question about the whole shop");
  if (hints.social) h.push("- it reads like small talk (greeting / thanks)");
  if (hints.sticky) h.push(`- the previous message landed on ${hints.sticky.slug ?? "all"} (${hints.sticky.minutesAgo} min ago)`);
  if (hints.staged) h.push(`- the terminal on the operator's screen belongs to ${hints.staged}`);

  return [
    "You route ONE chat message from the operator to the project it is about. Each project has its own assistant; you only pick which one answers.",
    "",
    "Projects:",
    projects || "(none)",
    "",
    "Open terminals per project (counts only):",
    terms || "(none)",
    "",
    "Where the last messages landed, oldest first:",
    recent || "(none)",
    "",
    "Hints from keyword rules (useful, but can be wrong or miss things):",
    h.join("\n") || "(none)",
    "",
    `Message: """${clip(text, 1200)}"""`,
    "",
    "Decide from meaning, not just keywords: a topic, a repo, a feature or a person that belongs to one project is about that project. A follow-up with no new topic continues the project the last message landed on. A change of topic is NOT a follow-up.",
    'Use "all" for a question about the whole shop, work spanning several projects, or small talk. Use "ask" only when you genuinely cannot tell.',
    'Answer with ONE line of JSON and nothing else: {"project":"<slug>|all|ask","confidence":0.0-1.0,"why":"<under 12 words>","candidates":["<slug>",...]}',
  ].join("\n");
}

/** The model's line → a route. Null when it is not something we can act on. */
export function parseRouteAnswer(out: string | null): ModelRoute | null {
  if (!out) return null;
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let p: any;
  try { p = JSON.parse(m[0]); } catch { return null; }
  const pick = String(p?.project ?? "").trim().replace(/^#/, "").toLowerCase();
  const confidence = Math.max(0, Math.min(1, Number(p?.confidence) || 0));
  const candidates = Array.isArray(p?.candidates) ? p.candidates.map((c: unknown) => String(c).replace(/^#/, "").toLowerCase()).filter(Boolean) : [];
  const why = clip(p?.why, 120) || "model";
  if (pick === "ask") return { ws: "ask", confidence, why, candidates };
  if (pick === "all" || pick === "fleet") return { ws: null, confidence, why, candidates };
  const w = workspaces.list().find((x) => x.slug.toLowerCase() === pick);
  if (!w) return null; // a slug that does not exist is a hallucination, not a route
  return { ws: w.id, confidence, why, candidates };
}

// With an API key the call goes straight to the Messages API (~1s, a fraction of a cent). Without
// one it runs the claude CLI on the operator's subscription: free, but the CLI's own start-up puts
// it at 3–11s per message.
const API_MODELS: Record<string, string> = { haiku: "claude-haiku-4-5-20251001" };

function apiModel(key: string): Ask {
  const model = API_MODELS[CONFIG.thread.routerModel] ?? CONFIG.thread.routerModel;
  return async (prompt) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(CONFIG.thread.routerTimeoutMs),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    noteHelperCall("route", { model, tokens_in: j.usage?.input_tokens, tokens_out: j.usage?.output_tokens });
    return (j.content || []).map((c: any) => c.text || "").join("") || null;
  };
}

function realModel(): Ask {
  if (CONFIG.thread.routerApiKey) return apiModel(CONFIG.thread.routerApiKey);
  const configDir = CONFIG.profiles[CONFIG.defaultProfile] ?? CONFIG.profiles.claude ?? "";
  const model = CONFIG.thread.routerModel || "haiku";
  return (prompt) => oneShotText(prompt, configDir, null, CONFIG.thread.routerTimeoutMs, model, "route");
}

/** One model call. Null = no usable answer; the caller routes by the rules instead. */
export async function modelRoute(text: string, hints: RouteHints): Promise<ModelRoute | null> {
  if (!routeModelEnabled()) return null;
  const ask = override ?? realModel();
  try {
    return parseRouteAnswer(await ask(routePrompt(text, hints)));
  } catch {
    return null;
  }
}

/**
 * Projects whose open terminals (title/goal) or recent operator messages share at least two
 * meaningful words with the message — computed locally so the routing prompt can say "matches an
 * open terminal in cedar" without carrying any client's text. Best match per project, strongest first.
 */
export function topicMatches(
  text: string,
  live: Array<{ workspace_id: string | null; title?: string | null; goal?: string | null }>,
): Array<{ slug: string; shared: number; what: string }> {
  const want = tokens(text);
  if (!want.size) return [];
  const best = new Map<string, { shared: number; what: string }>();
  const score = (wsId: string | null, s: string, what: string) => {
    if (!wsId) return;
    const sl = workspaces.get(wsId)?.slug;
    if (!sl) return;
    let n = 0;
    for (const t of tokens(s)) if (want.has(t)) n++;
    if (n >= 2 && n > (best.get(sl)?.shared ?? 0)) best.set(sl, { shared: n, what });
  };
  for (const s of live) score(s.workspace_id, `${s.title ?? ""} ${s.goal ?? ""}`, "an open terminal");
  for (const m of chat.recentAll(20) as any[]) if (m.you) score(m.workspace_id ?? null, m.you, "a recent message");
  return [...best.entries()].map(([slug, v]) => ({ slug, ...v })).sort((a, b) => b.shared - a.shared).slice(0, 3);
}

/**
 * A terminal's artifacts: the PRs it opened and the documents it wrote, pinned so the operator never
 * has to scroll back for a link.
 *
 * The rail beside the terminal answers "what is this, and what has happened since?" — but the two
 * things you still want an hour later are the PR you have to merge and the doc you asked for, and
 * both used to exist only as a line of scrollback that a long session eventually eats.
 *
 * Where they come from:
 *   · the ticket, when the terminal has one — `pr_url` + `pr_state` are already polled by delivery.ts,
 *     so that PR's state is free and authoritative.
 *   · the terminal's own screen — a PR URL the Desk read out of the pane (`gh pr create` prints it to
 *     stdout, which no transcript records). The page passes them in; they are filtered before use.
 *   · the Focus feed (focus.ts) — a URL the agent printed in its narration, or a markdown file a tool
 *     call wrote. The feed carries no tool RESULTS (see desk-companion.js), so `gh pr create`'s output
 *     is invisible: what is caught is the agent then SAYING the URL, which the goal templates and the
 *     progress protocol both ask it to do.
 *
 * A PR found in the feed has no state of its own, so `gh pr view` supplies it, behind a cache: a
 * merged/closed PR is terminal and never re-fetched, an open one is re-checked at most every 90s.
 * The viewer is injectable so tests never shell out (CLAUDE.md).
 */
import os from "node:os";
import { execFileTimed } from "./exec.js";
import { childEnv } from "./child-env.js";
import { repos, tickets, workspaces } from "./store.js";
import type { FocusEvent } from "./focus.js";
import type { Session } from "./types.js";

export type PrState = "open" | "merged" | "closed";

export interface PrPin {
  kind: "pr";
  url: string;
  repo: string;   // "owner/repo" — the rail shows the repo half
  num: number;
  state: PrState | null; // null = gh could not answer (offline, no auth): shown as unknown, never as merged
  title: string | null;
  source: "ticket" | "feed";
}

export interface DocPin {
  kind: "doc";
  /** Exactly one of the two: a link to open, or a path on this machine to copy. */
  url: string | null;
  path: string | null;
  label: string;
}

export interface SessionArtifacts {
  prs: PrPin[];
  docs: DocPin[];
}

// Fully-qualified PR links only. A bare "#412" is ambiguous across repos and a relative link is not
// something the rail can open, so neither is pinned.
const PR_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
// describeTool()'s phrasing for a write. Reads are not artifacts — the agent read your doc, it did
// not produce one.
const WROTE_RE = /^(?:Edit|Write|NotebookEdit)\s+(.+)$/;
// Written files that count as documentation. Deliberately narrow: a .ts file is the work, not a
// document about it.
const DOC_FILE_RE = /\.(md|mdx|rst|adoc)$/i;
// Hosted documents an agent can produce and then link to.
const DOC_URL_RE = /https?:\/\/(?:[\w.-]*\.)?(?:claude\.ai\/(?:artifact|public\/artifacts)|html-docs\.com|docs\.google\.com|notion\.so|notion\.site)\/\S*[^\s.,;:)\]}'"]/g;
// A link straight to a markdown file (a README on GitHub, a raw doc) is a document too.
const MD_URL_RE = /https?:\/\/\S+\.mdx?(?:\?\S*)?(?=$|[\s.,;:)\]}'"])/g;

const MAX_PRS = 8;
const MAX_DOCS = 8;
const OPEN_TTL_MS = 90_000;

const NOISE_PATH_RE = /(^|\/)(node_modules|\.git|dist)\//;

/** Trailing punctuation a sentence leaves glued to a URL, plus a fragment/query that is not identity. */
function cleanUrl(u: string): string {
  return u.replace(/[.,;:)\]}'"]+$/, "");
}

/** Last two segments — enough to know which document, short enough for a 280px column. */
function shortPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

/**
 * Everything the feed can tell us, without asking GitHub anything: PR links in the order they were
 * first said, documents in the order they were last touched. Both capped — a pin block longer than
 * the card it sits under is not a pin block.
 */
export function artifactsFromFeed(events: FocusEvent[] | null | undefined): { prs: Omit<PrPin, "state" | "title" | "source">[]; docs: DocPin[] } {
  const prs = new Map<string, Omit<PrPin, "state" | "title" | "source">>();
  const docs = new Map<string, DocPin>();
  for (const e of events || []) {
    if (!e || e.kind === "think") continue;
    const text = String(e.text ?? "");
    if (!text) continue;
    for (const m of text.matchAll(PR_RE)) {
      const url = `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
      if (!prs.has(url)) prs.set(url, { kind: "pr", url, repo: `${m[1]}/${m[2]}`, num: Number(m[3]) });
    }
    for (const re of [DOC_URL_RE, MD_URL_RE]) {
      for (const m of text.matchAll(re)) {
        const url = cleanUrl(m[0]);
        if (!docs.has(url)) docs.set(url, { kind: "doc", url, path: null, label: docLabel(url) });
      }
    }
    if (e.kind !== "act") continue;
    const wrote = WROTE_RE.exec(text.replace(/\s+/g, " ").trim());
    const p = wrote?.[1]?.trim();
    if (!p || !DOC_FILE_RE.test(p) || NOISE_PATH_RE.test(p)) continue;
    // Re-set so the most recently written document sorts last, like the timeline it sits above.
    docs.delete(p);
    docs.set(p, { kind: "doc", url: null, path: p, label: shortPath(p) });
  }
  return { prs: [...prs.values()].slice(-MAX_PRS), docs: [...docs.values()].slice(-MAX_DOCS) };
}

/** "…/document/d/1AbC/edit" → "docs.google.com", the only part of a hosted-doc URL worth 280px. */
function docLabel(url: string): string {
  try {
    const u = new URL(url);
    if (/\.mdx?$/i.test(u.pathname)) return shortPath(u.pathname);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

// ──────────────────────────── PR state, cached ────────────────────────────

export type PrView = { state?: string; title?: string; isDraft?: boolean };
export type ViewPrFn = (url: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<PrView | null>;

const realViewPr: ViewPrFn = async (url, cwd, env) => {
  try {
    const raw = (
      await execFileTimed("gh", ["pr", "view", url, "--json", "state,title,isDraft"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 10_000,
      })
    ).stdout.trim();
    return JSON.parse(raw) as PrView;
  } catch {
    return null; // offline, unauthenticated, or a repo this account cannot see — state stays unknown
  }
};

let viewPr: ViewPrFn = realViewPr;
/** Swap the gh lookup for tests. Pass null to restore. */
export function setViewPr(fn: ViewPrFn | null): void {
  viewPr = fn ?? realViewPr;
}

type CacheRow = { state: PrState | null; title: string | null; at: number };
const cache = new Map<string, CacheRow>();
/** Tests only: forget every cached PR state. */
export function clearPrCache(): void {
  cache.clear();
}

function toState(s: string | undefined): PrState | null {
  const up = String(s ?? "").trim().toUpperCase();
  if (up === "MERGED") return "merged";
  if (up === "CLOSED") return "closed";
  if (up === "OPEN") return "open";
  return null;
}

/**
 * Ask gh for each URL's state, at most once per 90s and never again once it is merged or closed.
 * Sequential on purpose: this runs behind a rail that repaints every few seconds, and six parallel
 * `gh` processes per poll is a spawn storm for a link nobody is racing to read.
 */
export async function prStates(
  urls: string[],
  ctx: { cwd: string; env: NodeJS.ProcessEnv },
  now = Date.now(),
): Promise<Map<string, CacheRow>> {
  const out = new Map<string, CacheRow>();
  for (const url of urls) {
    const hit = cache.get(url);
    const fresh = hit && (hit.state === "merged" || hit.state === "closed" || now - hit.at < OPEN_TTL_MS);
    if (fresh) {
      out.set(url, hit!);
      continue;
    }
    const view = await viewPr(url, ctx.cwd, ctx.env);
    // gh said nothing: keep whatever was known rather than blanking a state that was true a minute ago.
    const row: CacheRow = view ? { state: toState(view.state), title: view.title?.trim() || null, at: now } : { state: hit?.state ?? null, title: hit?.title ?? null, at: now };
    cache.set(url, row);
    out.set(url, row);
  }
  return out;
}

/**
 * The pins for one terminal. The ticket's PR comes first and costs nothing (delivery.ts already keeps
 * `pr_state` current); everything else the feed found is looked up.
 */
export async function sessionArtifacts(s: Session, events: FocusEvent[], onScreen: string[] = []): Promise<SessionArtifacts> {
  const found = artifactsFromFeed(events);
  // A PR the terminal PRINTED but never talked about (`gh pr create`): the Desk reads those off the
  // pane and passes them in, already filtered to real PR URLs by the endpoint.
  for (const url of onScreen) {
    if (found.prs.some((p) => p.url === url)) continue;
    const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url);
    if (m) found.prs.push({ kind: "pr", url, repo: `${m[1]}/${m[2]}`, num: Number(m[3]) });
  }
  // One request may not turn into sixteen `gh` calls: both sources are capped, and so is their sum.
  found.prs = found.prs.slice(-MAX_PRS);
  const ticket = s.ticket_id ? tickets.get(s.ticket_id) : undefined;
  const prs: PrPin[] = [];
  const seen = new Set<string>();
  if (ticket?.pr_url) {
    prs.push({
      kind: "pr",
      url: ticket.pr_url,
      repo: prRepoOf(ticket.pr_url),
      num: prNumOf(ticket.pr_url),
      state: (ticket.pr_state as PrState | null) ?? null,
      title: ticket.key ? `${ticket.key} — ${ticket.title}` : ticket.title,
      source: "ticket",
    });
    seen.add(ticket.pr_url);
  }
  const lookup = found.prs.filter((p) => !seen.has(p.url));
  if (lookup.length) {
    const repo = s.repo_id ? repos.get(s.repo_id) : undefined;
    const ws = s.workspace_id ? workspaces.get(s.workspace_id) : undefined;
    const states = await prStates(lookup.map((p) => p.url), {
      cwd: repo?.path || s.cwd || os.homedir(),
      env: childEnv(ws),
    });
    for (const p of lookup) {
      const st = states.get(p.url);
      prs.push({ ...p, state: st?.state ?? null, title: st?.title ?? null, source: "feed" });
    }
  }
  return { prs, docs: found.docs };
}

function prRepoOf(url: string): string {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/\d+/.exec(url);
  return m ? `${m[1]}/${m[2]}` : "";
}
function prNumOf(url: string): number {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? Number(m[1]) : 0;
}

/**
 * Surface-agnostic command table.
 *
 * Chronos grew several front-ends that each learned different tricks: Telegram
 * has the autonomy toggles, `mc` has cost/report. A command written for one never showed up in the
 * others, so "can I do X from here?" depended on where you were standing.
 *
 * Commands registered here are implemented ONCE and rendered by every surface. Handlers return
 * PLAIN TEXT — no markdown, no HTML — because that is the only thing all three can display
 * verbatim: the board posts markdown (asterisks would render), Telegram posts HTML (tags would escape),
 * `mc` writes to a terminal (both would be noise). Emoji and indentation are the shared formatting.
 *
 * Existing per-surface commands are deliberately NOT retrofitted here yet — this layer proves
 * itself on the new ones first.
 */
import {
  ideas as ideaStore,
  jobs,
  lessons as lessonStore,
  reviews,
  runs,
  searchIndex,
  skills as skillStore,
  ticketLinks,
  tickets,
  workspaces,
  LINK_TYPES,
} from "./store.js";
import { dispatch, stopRun } from "./dispatcher.js";
import { decideStall, listStalls } from "./recovery.js";
import { applyHold, resolveHoldTarget } from "./holds.js";
import { holdBucket } from "./hold-bucket.js";
import { abortWebTurn } from "./telegram/agent.js";
import { promoteIdea, killIdea } from "./ideas.js";
import { setSkillStatus } from "./skills.js";
import { captureLearnings, createNote, listNotes } from "./notes.js";
import { recall, renderRecall } from "./recall.js";
import { recordRecall } from "./memory-usage.js";
import { combinedSpend, combinedByWorkspace } from "./spend.js";
import { gateMode, quotaSnapshot, recentDecisions } from "./quota-gate.js";
import { analyticsWithDelta, RANGE_PRESETS } from "./analytics.js";
import type { LinkType } from "./store/tickets.js";

export interface CommandCtx {
  args: string[];
  /** Workspace the surface thinks the operator is in (Telegram active ws / board scope). */
  workspaceId?: string | null;
}

export interface Command {
  name: string;
  aliases: string[];
  usage: string;
  summary: string;
  run(ctx: CommandCtx): Promise<string> | string;
}

const money = (n: number) => `$${n.toFixed(2)}`;

function wsLabel(id: string | null | undefined): string {
  if (!id) return "unscoped";
  return workspaces.get(id)?.slug ?? id.slice(0, 8);
}

// "2h", "3d" — reviews and runs are only interesting relative to now.
function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.floor(ms / 60_000))}m`;
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const reviewsCmd: Command = {
  name: "reviews",
  aliases: ["pending", "queue"],
  usage: "reviews",
  summary: "every review waiting on you, oldest first",
  run() {
    const all = reviews.list("pending").sort((a, b) => a.created_at.localeCompare(b.created_at));
    // A review dated out to a day is not "waiting on you" today — but it is still listed, with its
    // date, because a deferral is a commitment and a silently missing row reads as a closed one.
    const pending = all.filter((r) => holdBucket(r) === "live");
    const later = all.filter((r) => holdBucket(r) === "dated");
    if (!pending.length && !later.length) return "✅ No reviews pending.";
    const lines = pending.map((r) => {
      const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
      const risk = r.risk && r.risk !== "low" ? ` · risk ${r.risk}` : "";
      return `· ${t?.key ?? "?"} — ${t?.title ?? "(ticket gone)"}\n  ${wsLabel(t?.workspace_id)} · waiting ${age(r.created_at)}${risk} · id ${r.id.slice(0, 8)}`;
    });
    const head = pending.length ? `📋 ${pending.length} review(s) pending:` : "✅ No reviews need you right now.";
    const tail = later.length
      ? [`⏰ later: ${later.map((r) => `${r.id.slice(0, 8)} → ${r.hold_until!.slice(0, 16).replace("T", " ")}`).join(" · ")}`]
      : [];
    return [head, ...lines, ...tail].join("\n");
  },
};

const costCmd: Command = {
  name: "cost",
  aliases: ["spend", "costs"],
  usage: "cost [today|7d|30d]",
  summary: "combined spend (headless + Desk) for a window, by workspace",
  run({ args }) {
    const window = (args[0] ?? "today").toLowerCase();
    const days = window === "30d" ? 30 : window === "7d" ? 7 : 0;
    const since = days
      ? new Date(Date.now() - days * 86_400_000).toISOString()
      : new Date().toISOString().slice(0, 10);
    const total = combinedSpend(since);
    const rows = combinedByWorkspace(since).filter((r) => r.total_usd > 0);
    const label = days ? `last ${days}d` : "today";
    if (!rows.length) {
      return `💸 ${label}: ${money(total.total_usd)} (no runs or Desk terminals)`;
    }
    const lines = rows.map((r) => {
      const bits = [
        `headless ${money(r.runs_usd)}/${r.runs}`,
        `Desk ${money(r.sessions_usd)}/${r.sessions}`,
      ];
      if (r.sessions_estimated_usd > 0) bits.push(`est ${money(r.sessions_estimated_usd)}`);
      return `· ${wsLabel(r.workspace_id || null)} — ${money(r.total_usd)} (${bits.join(" · ")})`;
    });
    const cov = total.coverage;
    const covLine =
      cov.estimated_usd > 0 || cov.unpriced_runs > 0
        ? `  coverage: priced ${money(cov.priced_usd)} · estimated Desk ${money(cov.estimated_usd)}` +
          (cov.unpriced_runs ? ` · ${cov.unpriced_runs} unpriced run(s)` : "")
        : null;
    return [
      `💸 Spend ${label}: ${money(total.total_usd)} (headless ${money(total.runs.usd)} · Desk ${money(total.sessions.usd)})`,
      ...lines,
      ...(covLine ? [covLine] : []),
    ].join("\n");
  },
};

// The other half of `cost`: not what was spent, what is LEFT. An exhausted profile and a never-logged-in
// CLI are the two facts that used to surface only as a failed run an hour later.
const quotaCmd: Command = {
  name: "quota",
  aliases: ["runway"],
  usage: "quota",
  summary: "what each provider credential has left, and the last dispatch verdicts",
  run() {
    const snap = quotaSnapshot();
    const mode = gateMode();
    const interesting = snap.entries.filter(
      (e) => e.runway !== "unknown" || e.auth !== "authenticated" || e.effectivePercentRemaining != null,
    );
    const icon = (e: (typeof snap.entries)[number]) =>
      e.runway === "exhausted_now" ? "🪫" : e.auth === "unauthenticated" ? "🔒" : e.runway === "projected_exhaustion" ? "⚠️" : "🔋";
    const lines = (interesting.length ? interesting : snap.entries).map((e) => {
      const bits = [
        e.effectivePercentRemaining == null ? "headroom unknown" : `${e.effectivePercentRemaining.toFixed(0)}% left`,
        `runway ${e.runway}`,
        e.resetsAt ? `resets ${e.resetsAt.slice(11, 16)}` : null,
        e.auth === "authenticated" ? null : `auth ${e.auth}`,
        e.spendPriority == null ? null : `priority ${e.spendPriority.toFixed(1)}`,
      ].filter(Boolean);
      const note = e.attention[0] ? `\n    ${e.attention[0]}` : "";
      return `${icon(e)} ${e.provider} ${e.scope} — ${bits.join(" · ")}${note}`;
    });
    const recent = recentDecisions(5).map((d) => `· ${d.job} — ${d.choice ? d.summary : `BLOCKED: ${d.summary}`}`);
    return [
      `🔌 Quota (gate: ${mode})`,
      ...lines,
      ...snap.attention.map((a) => `⚠️ ${a}`),
      ...(recent.length ? ["", "Last dispatch verdicts:", ...recent] : []),
    ].join("\n");
  },
};

const jobsCmd: Command = {
  name: "jobs",
  aliases: ["job", "cron"],
  usage: "jobs | jobs run <name|id>",
  summary: "list scheduled jobs, or run one now",
  run({ args }) {
    const all = jobs.list();
    if (args[0]?.toLowerCase() === "run") {
      const needle = args.slice(1).join(" ").trim();
      if (!needle) return "Usage: jobs run <name|id>";
      const job =
        jobs.get(needle) ??
        all.find((j) => j.name === needle) ??
        all.find((j) => (j.name ?? "").toLowerCase().includes(needle.toLowerCase()));
      if (!job) return `No job matching "${needle}".`;
      const r = dispatch(job.id, "command:jobs run");
      return "error" in r
        ? `❌ ${job.name}: ${r.error}`
        : `▶️ ${job.name} dispatched — run ${r.run_id.slice(0, 8)} (${r.status})`;
    }
    // Scheduled work only: one-shot ticket/plan/review jobs would bury the list.
    const scheduled = all.filter((j) => j.trigger_type === "cron" || j.cron_expr);
    if (!scheduled.length) return "No scheduled jobs.";
    const lines = scheduled.map(
      (j) => `· ${j.name}${j.enabled ? "" : " (disabled)"}\n  ${j.cron_expr ?? "no schedule"} · ${wsLabel(j.workspace_id)} · id ${j.id.slice(0, 8)}`
    );
    return [`⏰ ${scheduled.length} scheduled job(s):`, ...lines].join("\n");
  },
};

// Field names are the workspace columns; the short words are what anyone actually types.
const AUTONOMY: Record<string, "auto_plan" | "auto_build" | "auto_review" | "skill_distill" | "auto_skill"> = {
  plan: "auto_plan",
  build: "auto_build",
  review: "auto_review",
  distill: "skill_distill",
  skills: "auto_skill",
};

const autoCmd: Command = {
  name: "auto",
  aliases: ["autonomy"],
  usage: "auto [<workspace>] [plan|build|review|distill|skills on|off]",
  summary: "show or flip a workspace's autonomy switches",
  run({ args, workspaceId }) {
    const rest = [...args];
    // First arg is a workspace slug only if it names one — otherwise it's the switch.
    const bySlug = rest[0] ? workspaces.getBySlug(rest[0]) : undefined;
    if (bySlug) rest.shift();
    const ws = bySlug ?? (workspaceId ? workspaces.get(workspaceId) : undefined);
    if (!ws) return "Which workspace? Usage: auto <workspace> [plan|build|review on|off]";

    const show = () =>
      [
        `🎛 ${ws.slug} autonomy:`,
        ...Object.entries(AUTONOMY).map(
          ([word, field]) => `· ${word}: ${(ws as any)[field] ? "on" : "off"}`
        ),
      ].join("\n");

    if (!rest.length) return show();
    const field = AUTONOMY[rest[0].toLowerCase()];
    if (!field) return `Unknown switch "${rest[0]}". One of: ${Object.keys(AUTONOMY).join(", ")}`;
    const word = rest[1]?.toLowerCase();
    // No on/off given → toggle, matching the Telegram buttons' behaviour.
    const next = word === "on" ? 1 : word === "off" ? 0 : (ws as any)[field] ? 0 : 1;
    const updated = workspaces.update(ws.id, { [field]: next } as any);
    if (!updated) return `Could not update ${ws.slug}.`;
    return `🎛 ${ws.slug} ${rest[0].toLowerCase()} → ${next ? "on" : "off"}`;
  },
};

const stopCmd: Command = {
  name: "stop",
  aliases: ["abort", "cancel"],
  usage: "stop robert | stop <run-id> | stop all",
  summary: "stop an in-flight agent turn or a running job",
  run({ args, workspaceId }) {
    const target = (args[0] ?? "robert").toLowerCase();

    if (target === "robert" || target === "turn") {
      // Kills the workspace's warm manager process. The resume session id is deliberately kept, so
      // the next message continues the conversation rather than starting from nothing.
      return abortWebTurn(workspaceId ?? null)
        ? "🛑 Stopped Robert's turn. The thread keeps its context — just say the next thing."
        : "Nothing running for Robert here.";
    }

    if (target === "all") {
      const live = runs.listActive();
      const killed = live.filter((r) => stopRun(r.id)).length;
      const turn = abortWebTurn(workspaceId ?? null);
      const bits = [killed ? `${killed} run(s)` : null, turn ? "Robert's turn" : null].filter(Boolean);
      return bits.length ? `🛑 Stopped ${bits.join(" + ")}.` : "Nothing was running.";
    }

    // Anything else is a run id (full or 8-char prefix, as everything else prints them).
    const run =
      runs.get(target) ?? runs.listActive().find((r) => r.id.startsWith(target));
    if (!run) return `No running job matching "${target}".`;
    return stopRun(run.id)
      ? `🛑 Stopped run ${run.id.slice(0, 8)}. It will not retry — redispatch when you've decided why.`
      : `Run ${run.id.slice(0, 8)} was not running.`;
  },
};

const recoverCmd: Command = {
  name: "recover",
  aliases: ["stalled", "stuck"],
  usage: "recover | recover <id> ok|no | recover <id> later <+2d|ISO> [\"why\"]",
  summary: "work that stopped without finishing — resume it, drop it, or defer it to a date",
  async run({ args }) {
    const [handle, verdict] = args;
    if (!handle) {
      const live = listStalls().filter((s) => holdBucket(s) === "live");
      const held = listStalls().filter((s) => holdBucket(s) === "dated");
      if (!live.length && !held.length)
        return "✅ Nothing stalled. Everything dispatched has either finished or is still running.";
      const out = live.length
        ? [
            `🩺 ${live.length} stalled item(s) — nothing resumes until you say so:`,
            ...live.map((s) => `${s.line}\n  recover ${s.id} ok → ${s.action} · recover ${s.id} no → drop it · recover ${s.id} later +2d`),
          ]
        : ["✅ Nothing stalled needs you right now."];
      // Deferred ones are shown WITH their date rather than hidden: "later" is a commitment, not a delete.
      if (held.length) out.push(`⏰ later: ${held.map((s) => `${s.id} → ${s.hold_until!.slice(0, 16).replace("T", " ")}`).join(" · ")}`);
      return out.join("\n");
    }
    const v = (verdict ?? "").toLowerCase();
    // "later" is an answer too — it dates the call off the live list instead of leaving it live.
    if (["later", "hold", "snooze"].includes(v)) {
      const target = resolveHoldTarget("recovery", handle);
      if (!target) return `⚠️ Nothing stalled matches "${handle}".`;
      const out = applyHold(target, args[2] ?? "+2d", args.slice(3).join(" ") || null);
      if (!out.ok) return `⚠️ ${out.error}`;
      return `⏰ ${target.id} → later, back ${out.hold_until!.slice(0, 16).replace("T", " ")}. It resurfaces then; nothing was decided.`;
    }
    if (!["ok", "yes", "y", "no", "n", "drop"].includes(v))
      return `Say what to do: recover ${handle} ok (resume), recover ${handle} no (drop it), or recover ${handle} later +2d.`;
    return decideStall(handle, ["ok", "yes", "y"].includes(v));
  },
};

// Commands below need a workspace to act in. Surfaces supply one (Telegram active
// workspace, mc --workspace); a slug as the first argument overrides it.
function resolveWs(args: string[], workspaceId?: string | null) {
  const bySlug = args[0] ? workspaces.getBySlug(args[0]) : undefined;
  if (bySlug) args.shift();
  return bySlug ?? (workspaceId ? workspaces.get(workspaceId) : undefined);
}

const searchCmd: Command = {
  name: "search",
  aliases: ["find"],
  usage: "search <query>",
  summary: "full-text search across tickets, notes, skills, runs",
  run({ args, workspaceId }) {
    const q = args.join(" ").trim();
    if (!q) return "Usage: search <query>";
    const hits = searchIndex.search(q, { workspace: workspaceId ?? undefined, limit: 12 });
    if (!hits.length) return `Nothing matching "${q}".`;
    return [
      `🔎 ${hits.length} hit(s) for "${q}":`,
      ...hits.map((h) => `· [${h.kind}] ${h.title}\n  ${h.snippet.replace(/\s+/g, " ").trim()}`),
    ].join("\n");
  },
};

const recallCmd: Command = {
  name: "recall",
  aliases: [],
  usage: "recall [<workspace>] <query>",
  summary: "search this workspace's memory: memos, skills, lessons, past sessions",
  run({ args, workspaceId }) {
    const rest = [...args];
    const ws = resolveWs(rest, workspaceId);
    if (!ws) return "Which workspace? Usage: recall <workspace> <query>";
    const q = rest.join(" ").trim();
    if (!q) return "Usage: recall <query>";
    const hits = recall(ws.id, q);
    recordRecall(ws.id, q, hits, { source: "command" });
    return renderRecall(ws.id, q, hits);
  },
};

const memoCmd: Command = {
  name: "memo",
  aliases: ["memos"],
  usage: "memo [<workspace>] | memo [<workspace>] new <title> :: <body>",
  summary: "list the workspace's memos, or write a new one",
  run({ args, workspaceId }) {
    const rest = [...args];
    const ws = resolveWs(rest, workspaceId);
    if (!ws) return "Which workspace? Usage: memo <workspace> [new <title> :: <body>]";

    if (rest[0]?.toLowerCase() === "new") {
      // "title :: body" — the separator keeps multi-word titles working without quoting, which
      // matters when the command is typed into a chat client rather than a shell.
      const raw = rest.slice(1).join(" ");
      const [title, ...bodyParts] = raw.split("::");
      if (!title?.trim()) return "Usage: memo new <title> :: <body>";
      const n = createNote({
        workspace_id: ws.id,
        title: title.trim(),
        body: bodyParts.join("::").trim() || undefined,
      } as any);
      return `📝 Memo "${n.title}" saved in ${ws.slug} (${n.id.slice(0, 8)}).`;
    }

    const notes = listNotes(ws.id);
    if (!notes.length) return `No memos in ${ws.slug}.`;
    return [
      `📝 ${notes.length} memo(s) in ${ws.slug}:`,
      ...notes
        .slice(0, 20)
        .map((n) => `· ${n.title}${n.context ? " ★" : ""}${n.pinned ? " 📌" : ""} — ${n.id.slice(0, 8)}`),
    ].join("\n");
  },
};

const learnCmd: Command = {
  name: "learn",
  aliases: ["lesson", "lessons"],
  usage: "learn [<workspace>] <durable fact> | learn list | learn rm <id>",
  summary: "record a lasting fact, or manage distilled lessons",
  run({ args, workspaceId }) {
    const rest = [...args];
    const sub = rest[0]?.toLowerCase();

    if (sub === "list") {
      rest.shift();
      const ws = resolveWs(rest, workspaceId);
      const list = lessonStore.list({ workspace_id: ws?.id, state: "active" });
      if (!list.length) return ws ? `No active lessons in ${ws.slug}.` : "No active lessons.";
      return [
        `🎓 ${list.length} active lesson(s)${ws ? ` in ${ws.slug}` : ""}:`,
        ...list.slice(0, 20).map((l) => `· [${l.topic}] ${l.rule}\n  fired ${l.hits}× · ${l.id.slice(0, 8)}`),
      ].join("\n");
    }

    if (sub === "rm" || sub === "archive") {
      const id = rest[1];
      if (!id) return "Usage: learn rm <id>";
      const hit = lessonStore.get(id) ?? lessonStore.list({}).find((l) => l.id.startsWith(id));
      if (!hit) return `No lesson matching "${id}".`;
      lessonStore.update(hit.id, { state: "archived" });
      return `🎓 Archived: ${hit.rule.slice(0, 80)}`;
    }

    const ws = resolveWs(rest, workspaceId);
    if (!ws) return "Which workspace? Usage: learn <workspace> <durable fact>";
    const fact = rest.join(" ").trim();
    if (!fact) return "Usage: learn <durable fact>";
    // Same path `mc learn` uses, so a fact captured here lands in the workspace's learnings memo
    // and gets injected into future agents exactly like one captured by a build agent.
    const note = captureLearnings(ws.id, [fact], "operator");
    return note ? `🎓 Learned for ${ws.slug}: ${fact}` : `Could not record that for ${ws.slug}.`;
  },
};

const skillsCmd: Command = {
  name: "skills",
  aliases: ["skill"],
  usage: "skills | skills approve <id> | skills reject <id>",
  summary: "list pending skills and approve or reject them",
  run({ args, workspaceId }) {
    const sub = args[0]?.toLowerCase();
    if (sub === "approve" || sub === "reject") {
      const ref = args[1];
      if (!ref) return `Usage: skills ${sub} <id>`;
      const hit =
        skillStore.get(ref) ??
        skillStore.list({}).find((s) => s.id.startsWith(ref) || s.slug === ref);
      if (!hit) return `No skill matching "${ref}".`;
      const s = setSkillStatus(hit.id, sub === "approve" ? "active" : "archived");
      return `${sub === "approve" ? "✅ Approved" : "🗑 Rejected"}: ${s.name}`;
    }
    const pending = skillStore.list({ workspace_id: workspaceId ?? undefined, status: "pending" });
    if (!pending.length) return "No skills pending approval.";
    return [
      `🧠 ${pending.length} skill(s) pending:`,
      ...pending.map((s) => `· ${s.name} — ${s.description.slice(0, 100)}\n  ${s.id.slice(0, 8)}`),
    ].join("\n");
  },
};

const ideasCmd: Command = {
  name: "ideas",
  aliases: ["idea"],
  usage: "ideas | ideas promote <id> | ideas kill <id>",
  summary: "list proposed ideas and promote or kill them",
  async run({ args, workspaceId }) {
    const sub = args[0]?.toLowerCase();
    const find = (ref: string) =>
      ideaStore.get(ref) ?? ideaStore.list({}).find((i) => i.id.startsWith(ref));

    if (sub === "promote" || sub === "kill") {
      const ref = args[1];
      if (!ref) return `Usage: ideas ${sub} <id>`;
      const hit = find(ref);
      if (!hit) return `No idea matching "${ref}".`;
      if (sub === "kill") {
        killIdea(hit.id);
        return `🗑 Killed: ${hit.title}`;
      }
      const t = await promoteIdea(hit.id);
      return `🎫 ${t.key} created from "${hit.title}".`;
    }

    const proposed = ideaStore.list({ workspace_id: workspaceId ?? undefined, status: "proposed" });
    if (!proposed.length) return "No ideas proposed.";
    return [
      `💡 ${proposed.length} idea(s) proposed:`,
      ...proposed.map((i) => `· ${i.title} [${i.kind}]\n  ${i.pitch.slice(0, 110)}\n  ${i.id.slice(0, 8)}`),
    ].join("\n");
  },
};

const linkCmd: Command = {
  name: "link",
  aliases: ["links"],
  usage: "link <KEY> | link <FROM> <blocks|parent|relates|duplicates> <TO>",
  summary: "show or change how tickets relate",
  run({ args }) {
    const byKey = (k: string) => tickets.list().find((t) => t.key.toUpperCase() === k.toUpperCase());
    const [a, type, b] = args;
    if (!a) return "Usage: link <KEY> — or link <FROM> <type> <TO>";

    // One argument = show this ticket's links.
    if (!type) {
      const t = byKey(a);
      if (!t) return `No ticket ${a}.`;
      const links = ticketLinks.forTicket(t.id);
      if (!links.length) return `${t.key} has no links.`;
      return [
        `🔗 ${t.key} links:`,
        ...links.map((l) => `· ${l.dir === "out" ? "→" : "←"} ${l.type} ${l.ticket.key} — ${l.ticket.title.slice(0, 60)}`),
      ].join("\n");
    }

    if (!LINK_TYPES.includes(type as LinkType))
      return `Link type must be one of: ${LINK_TYPES.join(", ")}`;
    if (!b) return "Usage: link <FROM> <type> <TO>";
    const from = byKey(a);
    const to = byKey(b);
    if (!from) return `No ticket ${a}.`;
    if (!to) return `No ticket ${b}.`;
    ticketLinks.add(from.id, to.id, type as LinkType);
    return `🔗 ${from.key} ${type} ${to.key}`;
  },
};

// `unlink` shares linkCmd's name lookup but removes instead — kept separate so the verb reads right.
const unlinkCmd: Command = {
  name: "unlink",
  aliases: [],
  usage: "unlink <FROM> <type> <TO>",
  summary: "remove a link between two tickets",
  run({ args }) {
    const [a, type, b] = args;
    if (!a || !type || !b) return "Usage: unlink <FROM> <type> <TO>";
    const byKey = (k: string) => tickets.list().find((t) => t.key.toUpperCase() === k.toUpperCase());
    const from = byKey(a);
    const to = byKey(b);
    if (!from || !to) return `No ticket ${!from ? a : b}.`;
    const link = ticketLinks
      .forTicket(from.id)
      .find((l) => l.type === type && l.ticket.id === to.id && l.dir === "out");
    if (!link) return `${from.key} has no outgoing ${type} link to ${to.key}.`;
    ticketLinks.remove(link.id);
    return `🔗 Removed ${from.key} ${type} ${to.key}`;
  },
};

// The /altitude dashboard, in text. Same module, same window arithmetic — a number Telegram reports
// and a number the chart draws can never disagree, because neither re-derives it.
const altitudeCmd: Command = {
  name: "altitude",
  aliases: ["analytics", "dash"],
  usage: "altitude [today|7d|30d|90d|mtd|last-month|qtd|last-quarter|ytd|all]",
  summary: "spend, usage and terminals over a window, by client — the dashboard as text",
  run({ args, workspaceId }) {
    const preset = (args[0] ?? "30d").toLowerCase();
    const known = RANGE_PRESETS.some((p) => p.key === preset);
    if (args[0] && !known) {
      return `❓ Unknown window "${args[0]}". Try: ${RANGE_PRESETS.map((p) => p.key).join(" | ")}`;
    }
    const a = analyticsWithDelta({ preset, workspace_id: workspaceId ?? undefined, top: 5 });
    const t = a.totals;
    const arrow = (d: number | null) => (d == null ? "" : d >= 0 ? ` (+${d}%)` : ` (${d}%)`);
    const tokens = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
    const head = [
      `📊 ${a.range.label}${a.range.workspace_id ? ` · ${wsLabel(a.range.workspace_id)}` : ""} — ${money(t.usd)}${arrow(a.delta.usd)}`,
      `  headless ${money(t.runs_usd)}/${t.runs} runs · Desk ${money(t.sessions_usd)}/${t.sessions} terminals` +
        (t.estimated_usd > 0 ? ` · est ${money(t.estimated_usd)}` : ""),
      `  ${tokens(t.tokens_total)} tokens · ${t.turns} turns · ${t.model_minutes}m model time` +
        (t.success_rate != null ? ` · ${t.success_rate}% runs ok` : ""),
    ];
    // A sparkline is the only chart that survives Telegram, the board and a terminal unchanged.
    const spark = (() => {
      const vals = a.series.map((p) => p.usd);
      if (vals.length < 2) return null;
      const max = Math.max(...vals);
      if (max <= 0) return null;
      const glyphs = "▁▂▃▄▅▆▇█";
      const bars = vals.map((v) => glyphs[Math.min(7, Math.round((v / max) * 7))]).join("");
      return `  ${bars}  ${a.series[0].bucket} → ${a.series[a.series.length - 1].bucket} (peak ${money(max)}/${a.range.bucket})`;
    })();
    const wsLines = a.by_workspace
      .filter((w) => w.usd > 0)
      .slice(0, 8)
      .map((w) => `· ${w.slug} — ${money(w.usd)} (${w.share}%) · ${w.runs} runs · ${w.sessions} terminals`);
    const topTerm = a.top_terminals
      .filter((x) => x.usd > 0)
      .slice(0, 3)
      .map((x) => `· ${money(x.usd)} — ${x.title.slice(0, 60)}${x.estimated ? " (est)" : ""}`);
    return [
      ...head,
      ...(spark ? [spark] : []),
      ...(wsLines.length ? ["", "By client:", ...wsLines] : []),
      ...(topTerm.length ? ["", "Priciest terminals:", ...topTerm] : []),
    ].join("\n");
  },
};

export const COMMANDS: Command[] = [
  reviewsCmd,
  costCmd,
  quotaCmd,
  altitudeCmd,
  jobsCmd,
  autoCmd,
  stopCmd,
  recoverCmd,
  searchCmd,
  recallCmd,
  memoCmd,
  learnCmd,
  skillsCmd,
  ideasCmd,
  linkCmd,
  unlinkCmd,
];

const BY_NAME = new Map<string, Command>();
for (const c of COMMANDS) {
  BY_NAME.set(c.name, c);
  for (const a of c.aliases) BY_NAME.set(a, c);
}

export function findCommand(word: string): Command | undefined {
  return BY_NAME.get(word.trim().toLowerCase().replace(/^[!/]/, ""));
}

/**
 * Run a raw command line ("cost 7d"). Returns null when the first word isn't a registered command,
 * so a caller can fall through to its own parser or to the LLM.
 */
export async function runCommandLine(
  line: string,
  ctx: Omit<CommandCtx, "args"> = {}
): Promise<string | null> {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const cmd = findCommand(parts[0]);
  if (!cmd) return null;
  try {
    return await cmd.run({ ...ctx, args: parts.slice(1) });
  } catch (e: any) {
    return `❌ ${cmd.name} failed: ${e?.message ?? e}`;
  }
}

export function commandHelp(): string {
  return COMMANDS.map((c) => `· ${c.usage} — ${c.summary}`).join("\n");
}

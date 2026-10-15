import { runs, workspaces, tickets, reviews, sessions, skills, ideas, kv, chat as chatLog, asks as asksStore } from "./store.js";
import { answerAsk } from "./asks.js";
import { commandHelp, findCommand, runCommandLine } from "./commands.js";
import { setSkillStatus } from "./skills.js";
import { promoteIdea, killIdea } from "./ideas.js";
import { promoteAllIntake } from "./intake.js";
import { status as dispatchStatus } from "./dispatcher.js";
import { dispatchTicket, dispatchPlan } from "./tickets.js";
import { approve, requestChanges, merge } from "./reviews.js";
import { fleetData, composeFleet } from "./fleet.js";
import * as noteSvc from "./notes.js";
import { CONFIG } from "./config.js";
import { tg, send, esc, TOKEN, getAllowedChat, setAllowedChat, transportFailStreak } from "./telegram/api.js";
import { decideStall } from "./recovery.js";
import { answerPromptTap } from "./terminal-prompts.js";
import { decideWriteback } from "./writeback.js";
import { skillKb, skillCard, ideaKb, ideaCard, reviewKb, menuKb, autonomyKb, wsListKb, ticketKb, STATUS_ICON, prIcon, kb, holdKb } from "./telegram/keyboards.js";
import { applyHold, resolveHoldTarget, type HoldKind } from "./holds.js";
import { tomorrowAt } from "./hold-bucket.js";
import { runAgent, deliverToActiveExec, asksForChat, abortKb, abortAsk, abortAll, execProposal, dismissProposal, prewarmTelegram, purgeExpiredProposals, answerRouteAsk } from "./telegram/agent.js";
import { EXEC_LINE, EXEC_NAME, EXEC_SLASH, execCommand, getActiveExec, setActiveExec } from "./telegram/active-exec.js";
import { watchRun, registerTicker } from "./telegram/ticker.js";
import { registerPush } from "./telegram/push.js";
import { handleVoice } from "./telegram/voice.js";
import { handleMedia, tryPinAttachTarget } from "./telegram/media.js";

// Re-export so the rest of the daemon keeps importing notify from "./telegram.js".
export { notify } from "./telegram/api.js";

// Active workspace per chat (scopes /tickets, /dispatch, /search, and the conversational agent).
// Cache over the kv table (lazy-read, write-through) so it survives daemon restarts.
const activeWsCache = new Map<number, string>();
function getActiveWsId(chatId: number): string | undefined {
  if (activeWsCache.has(chatId)) return activeWsCache.get(chatId);
  const v = kv.get(`tg.activeWs.${chatId}`);
  if (v) activeWsCache.set(chatId, v);
  return v;
}
function setActiveWsId(chatId: number, wsId: string) {
  activeWsCache.set(chatId, wsId);
  kv.set(`tg.activeWs.${chatId}`, wsId);
}
function curWs(chatId: number) {
  const id = getActiveWsId(chatId);
  return id ? workspaces.get(id) : undefined;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

// Typed messages are natural language for the manager agent. Only two escapes bypass it — /abort
// (stop a stuck/spending ask, must work when the agent itself is wedged) and /start·/help (welcome).
// /claim is the pre-link onboarding escape, handled in poll() before a chat is linked.
export function routeText(text: string): "claim" | "abort" | "start" | "conv" | "who" | "exec" | "command" | "agent" {
  const t = (text ?? "").trim();
  if (/^\/claim(\s|$)/.test(t)) return "claim";
  if (/^\/abort(\s|$)/.test(t)) return "abort";
  if (/^\/(start|help)(\s|$)/.test(t)) return "start";
  if (/^\/conv(s|ersations?)?(\s|$)/.test(t)) return "conv";
  if (/^\/who(\s|$)/.test(t)) return "who";
  // /robert — switch which executive this chat talks to. Robert is the only one left (the retired
  // /ada, /ham, /iris and /vega no longer resolve), but the hop stays: it is how a chat gets back
  // to the default, and it is the seam a second executive would return through. Checked before the
  // command table: no command shares a name with an executive, and if one ever does, the person wins.
  if (execCommand(t)) return "exec";
  // Shared command table (/cost, /reviews, /jobs, /auto, /stop) — same commands `mc` has.
  // Deterministic and free, where the agent would cost a turn to reach the same store call. Only an
  // explicit leading slash counts, so ordinary prose that happens to start with "cost" still talks
  // to Robert.
  if (t.startsWith("/") && findCommand(t.slice(1).split(/\s+/)[0])) return "command";
  return "agent";
}

const WELCOME =
  "<b>Mission Control</b>\n\n" +
  "Just talk to me — I run your agents, tickets, jobs and spend.\n" +
  "• “what’s going on?” · “dispatch the acme ticket” · “weekly report for globex” · “how much have we spent?”\n" +
  "• Anything that changes something comes back as a ✅/❌ confirm card — tap to run it.\n" +
  "• /robert talks to him directly (he acts, no cards). /who shows where you are.\n" +
  "• /conv switches which Mission Control conversation you continue.\n" +
  "• /abort stops a running ask.\n" +
  "• Commands (same as <code>mc</code>):\n" +
  commandHelp().replace(/^/gm, "  ");

async function handle(chatId: number, text: string, msgId = 0) {
  switch (routeText(text)) {
    case "abort": {
      if (text.trim().slice(6).trim() === "all") { const n = abortAll(chatId); return send(chatId, `🛑 aborted ${n} ask(s)`); }
      const mine = asksForChat(chatId);
      if (!mine.length) return send(chatId, "No chat asks running.");
      return send(chatId, "Live asks — tap to abort:", abortKb(mine));
    }
    case "claim":
    case "start":
      return send(chatId, WELCOME);
    case "command": {
      // Handlers return plain text (the one format all three surfaces render), so escape it into
      // the HTML parse mode this bot posts in rather than sending it raw.
      const out = await runCommandLine(text.trim().slice(1), { workspaceId: curWs(chatId)?.id ?? null });
      return send(chatId, esc(out ?? "Unknown command."));
    }
    case "conv": {
      // Pick which Mission Control conversation this chat continues. Tapping a workspace sets the
      // active workspace (ws.* callback), and the next message picks up that thread where Flow left it.
      const cur = curWs(chatId);
      const last = chatLog.recent(1, cur?.id ?? null)[0];
      return send(
        chatId,
        `<b>Continue a Mission Control conversation</b>\n\n` +
          `Now on: <b>${cur ? esc(cur.name) : "All workspaces"}</b>\n` +
          (last ? `Last: <i>${esc(last.you.slice(0, 90))}</i>\n\n` : "\n") +
          `Pick a workspace — your next message continues that thread.\n` +
          `<i>From here I can read and propose; anything that changes something still comes back as a ✅/❌ card.</i>`,
        wsListKb(cur?.id),
      );
    }
    case "who": {
      const cur = getActiveExec(chatId);
      return send(
        chatId,
        `Talking to <b>${EXEC_NAME[cur]}</b> — ${esc(EXEC_LINE[cur] ?? "")}\n\n` +
          Object.keys(EXEC_NAME).map((id) => `${EXEC_SLASH[id]} — ${esc(EXEC_NAME[id])}`).join("\n"),
      );
    }
    case "exec": {
      const id = execCommand(text)!;
      setActiveExec(chatId, id);
      // "/ada pedime un café" switches AND asks in one go — the tail after the command is the
      // first message, so the common case is one line, not two.
      const tail = text.trim().replace(/^\/[a-z]+\s*/i, "").trim();
      if (tail) {
        void deliverToActiveExec(chatId, tail, msgId);
        return;
      }
      return send(
        chatId,
        `Now talking to <b>${EXEC_NAME[id]}</b> — ${esc(EXEC_LINE[id] ?? "")}\n` +
          (id === "robert"
            ? `<i>Anything that changes something comes back as a ✅/❌ card.</i>`
            : `<i>${EXEC_NAME[id]} acts directly here, same as on the desk — no confirm cards. /robert to go back.</i>`),
      );
    }
    default:
      // Natural language → whichever executive this chat is pointed at (parallel fire-and-forget;
      // keeps the poll loop free).
      void deliverToActiveExec(chatId, text, msgId);
      return;
  }
}

// Card surfaces reachable from the inline nav hub (menuKb). NOT a typed interface — only button taps
// in handleCallback reach these; typed text always routes to the agent.
async function runCommand(chatId: number, cmd: string) {
  switch (cmd) {
    case "/today": {
      const w = curWs(chatId);
      const wsId = w?.id;
      const review = tickets.list({ workspace_id: wsId, status: "review" });
      const planned = tickets.list({ workspace_id: wsId, status: "planned" });
      const prog = tickets.list({ workspace_id: wsId, status: "in_progress" });
      const tag = (t: any) => `${esc(t.key)} ${esc(t.title.slice(0, 50))}`;
      const lines = [`<b>Today${w ? " · " + esc(w.name) : ""}</b>`];
      lines.push(`\n⟳ <b>Needs review</b> (${review.length})` + (review.length ? "\n" + review.slice(0, 8).map(tag).join("\n") : ""));
      lines.push(`\n🧭 <b>Plan ready</b> (${planned.length})` + (planned.length ? "\n" + planned.slice(0, 8).map(tag).join("\n") : ""));
      lines.push(`\n▶ <b>In progress</b> (${prog.length})` + (prog.length ? "\n" + prog.slice(0, 8).map(tag).join("\n") : ""));
      await send(chatId, lines.join("\n"));
      // Plan-ready tickets get a one-tap Build button (approve plan → build).
      for (const t of planned.slice(0, 6))
        await send(chatId, `🧭 <b>${esc(t.key)}</b> ${esc(t.title.slice(0, 60))} — plan ready`, ticketKb(t)!);
      return;
    }

    case "/tickets": {
      const w = curWs(chatId);
      const list = tickets.list({ workspace_id: w?.id });
      if (!list.length) return send(chatId, w ? `No tickets in ${esc(w.name)}.` : "No active workspace.");
      await send(chatId, `<b>${w ? esc(w.name) : "All"} tickets</b>\n` +
        list.slice(0, 20).map((t) => `${STATUS_ICON[t.status] ?? "•"} <code>${esc(t.key)}</code> ${esc(t.title)} <i>${t.status}</i>${prIcon(t)}`).join("\n"));
      // Buttoned cards for the actionable ones (backlog/ready/planned → dispatch/plan/build).
      const actionable = list.filter((t) => ticketKb(t)).slice(0, 8);
      for (const t of actionable)
        await send(chatId, `${STATUS_ICON[t.status] ?? "•"} <b>${esc(t.key)}</b> ${esc(t.title.slice(0, 60))} <i>${t.status}</i>`, ticketKb(t)!);
      return;
    }

    case "/sessions": {
      const w = curWs(chatId);
      const list = sessions.list({ workspace_id: w?.id }).slice(0, 20);
      if (!list.length) return send(chatId, w ? `No sessions in ${esc(w.name)}.` : "No sessions.");
      return send(chatId, `<b>${w ? esc(w.name) : "All"} sessions</b>\n` +
        list.map((s: any) => `${s.status === "live" ? "🟢" : "⚪"} <code>${s.id.slice(0, 8)}</code> ${esc(s.title || s.ticket_key || "untitled")}${s.ticket_key ? " <i>" + esc(s.ticket_key) + "</i>" : ""}`).join("\n"));
    }

    case "/review": {
      const list = reviews.list("pending");
      if (!list.length) return send(chatId, "No reviews pending. 🎉");
      send(chatId, "<b>Pending reviews</b> — tap to decide:");
      for (const r of list.slice(0, 10)) {
        const t = r.ticket_id ? tickets.get(r.ticket_id) : undefined;
        await send(chatId, `🟡 ${t ? esc(t.key + " " + t.title) : "(run)"}${r.diff_ref ? " · diff" : ""}`, reviewKb(r));
      }
      return;
    }

    case "/skills": {
      const w = curWs(chatId);
      const pend = skills.list({ status: "pending" }).filter((s) => !w || s.workspace_id === w.id);
      if (!pend.length) return send(chatId, `No skills awaiting approval. 🎉${w ? " (" + esc(w.name) + ")" : ""}`);
      send(chatId, "<b>Skills awaiting approval</b> — tap a skill to view + decide:");
      // One message per pending skill so each carries its own Approve/Reject buttons.
      for (const s of pend.slice(0, 10)) {
        const ws = workspaces.get(s.workspace_id);
        await send(chatId, `🧩 <b>${esc(s.slug)}</b>${ws ? " · <i>" + esc(ws.name) + "</i>" : ""}\n${esc(s.description.slice(0, 120))}`,
          kb([[{ text: "📖 View", data: `sk.v.${s.id.slice(0, 8)}` }, { text: "✅ Approve", data: `sk.ok.${s.id.slice(0, 8)}` }, { text: "✕ Reject", data: `sk.no.${s.id.slice(0, 8)}` }]]));
      }
      return;
    }

    case "/ideas": {
      const w = curWs(chatId);
      const pool = ideas.list({ status: "proposed" }).filter((i) => !w || i.workspace_id === w.id);
      if (!pool.length) return send(chatId, `No ideas in the pool. 🎉${w ? " (" + esc(w.name) + ")" : ""}`);
      await send(chatId, `<b>Idea pool</b> (${pool.length}) — tap to promote or kill:`);
      for (const i of pool.slice(0, 10)) {
        await send(chatId, ideaCard(i), ideaKb(i));
      }
      return;
    }

    case "/status": {
      const s = dispatchStatus();
      const c = runs.statusCounts(daysAgo(30));
      const done = (c.success ?? 0) + (c.failed ?? 0) + (c.timeout ?? 0);
      const rate = done ? Math.round(((c.success ?? 0) / done) * 100) : null;
      return send(chatId,
        `🟢 <b>Chronos</b>\n` +
        `active ${s.active}/${s.max_concurrent} · queued ${s.queued}\n` +
        `spend: $${s.spent_today_usd.toFixed(2)}/$${s.daily_budget_usd} today · ` +
        `$${runs.spentSince(daysAgo(7)).toFixed(2)} 7d · $${runs.spentSince(daysAgo(30)).toFixed(2)} 30d\n` +
        (rate != null ? `30d: ${rate}% ok (${c.success ?? 0}✓ ${(c.failed ?? 0) + (c.timeout ?? 0)}✗)` : "no runs yet"));
    }
  }
}

// Inline-button taps arrive as callback_query updates. Route ns.op.id8 → action, ack the spinner,
// strip the keyboard, and confirm. Same auth guard as messages (allowed chat only).
async function handleCallback(cb: any) {
  const chatId = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  const ack = (text?: string, alert = false) =>
    tg("answerCallbackQuery", { callback_query_id: cb.id, ...(text ? { text } : {}), ...(alert ? { show_alert: true } : {}) });
  const allowedChat = getAllowedChat();
  if (!allowedChat || String(chatId) !== allowedChat) return ack("not linked");
  const stripKb = () => tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [] } });
  const [ns, op, id] = String(cb.data || "").split(".");
  try {
    if (ns === "sk") {
      const s = skills.list().find((x) => x.id.startsWith(id));
      if (!s) { await ack("skill no longer exists"); return stripKb(); }
      if (op === "v") { await ack(); return send(chatId, skillCard(s), skillKb(s)); }
      if (op === "ok") { setSkillStatus(s.id, "active"); await ack("✅ approved — live in agents"); await stripKb(); return send(chatId, `✅ <b>${esc(s.slug)}</b> → active`); }
      if (op === "no") { setSkillStatus(s.id, "archived"); await ack("✕ rejected"); await stripKb(); return send(chatId, `✕ <b>${esc(s.slug)}</b> archived`); }
    }
    if (ns === "ip") {
      const idea = ideas.list().find((x) => x.id.startsWith(id));
      if (!idea) { await ack("idea no longer exists"); return stripKb(); }
      if (op === "ok") {
        const ticket = await promoteIdea(idea.id);
        await ack("✅ promoted → ticket");
        await stripKb();
        return send(chatId, `✅ <b>${esc(idea.title)}</b> → <code>${esc(ticket.key)}</code>`);
      }
      if (op === "no") {
        killIdea(idea.id);
        await ack("✕ killed");
        await stripKb();
        return send(chatId, `✕ <b>${esc(idea.title)}</b> killed`);
      }
    }
    if (ns === "ib") {
      const ws = workspaces.list().find((w) => w.id.startsWith(id));
      if (!ws) { await ack("workspace no longer exists"); return stripKb(); }
      if (op === "no") { await ack("left in the pool"); return stripKb(); }
      if (op === "all") {
        const { promoted, failed } = await promoteAllIntake(ws.id);
        await ack(promoted ? `✅ ${promoted} → backlog` : "nothing left to promote");
        await stripKb();
        return send(
          chatId,
          `✅ <b>${esc(ws.name)}</b> · ${promoted} draft${promoted === 1 ? "" : "s"} → backlog` +
            (failed ? ` · ${failed} failed` : ""),
        );
      }
    }
    if (ns === "rv") {
      const r = reviews.list().find((x) => x.id.startsWith(id));
      if (!r) { await ack("review no longer exists"); return stripKb(); }
      const fn = op === "ap" ? approve : op === "ch" ? requestChanges : merge;
      const out = await fn(r.id);
      const prUrl = (out as any)?.pr_url;
      await ack(out ? `✓ ${op === "ap" ? "approved" : op === "ch" ? "changes requested" : "merged"}` : "failed");
      await stripKb();
      return send(chatId, out ? `${op === "ap" ? "✅" : op === "ch" ? "🔁" : "🔀"} review <code>${r.id.slice(0, 8)}</code> → ${out.state}${prUrl ? `\n🔗 ${esc(prUrl)}` : ""}` : "Failed.");
    }
    if (ns === "tk") {
      const t = tickets.list().find((x) => x.key.toLowerCase() === id.toLowerCase());
      if (!t) { await ack("ticket no longer exists"); return stripKb(); }
      const r = await (op === "b" ? dispatchTicket(t.id) : dispatchPlan(t.id));
      await ack(op === "b" ? "🚀 building…" : "🧭 planning…");
      await stripKb();
      if (r.run_id) return watchRun(r.run_id, Number(chatId), op === "b" ? t.key : `plan ${t.key}`);
      return send(chatId, `⚠️ ${esc(r.status ?? "dispatch failed")}`);
    }
    // Morning-brief tap-to-plan: dispatch the read-only planning agent for an arrived backlog ticket.
    // Keyboard is left intact (multiple independent buttons); the ack is the feedback.
    if (ns === "br" && op === "p") {
      const t = tickets.list().find((x) => x.id.startsWith(id));
      if (!t) return ack("ticket no longer exists");
      if (t.status !== "backlog") return ack(`already ${t.status}`); // double-tap / raced by auto_plan
      const r = dispatchPlan(t.id);
      await ack(`🧭 planning ${t.key}…`);
      if (r.run_id) return watchRun(r.run_id, Number(chatId), `plan ${t.key}`);
      return send(chatId, `⚠️ ${esc(r.status ?? "dispatch failed")}`);
    }
    // Retired learnings-promotion card: taps on one still sitting in the chat. ★-ing the whole inbox
    // would inject all of it into every prompt; the dream pass promotes it line by line instead.
    if (ns === "lp") { await ack("retired — the dream pass triages the inbox now"); return stripKb(); }
    // A routing question (src/thread-router.ts): the tap re-runs the message the operator already
    // sent, on the workspace he picked — its own Robert, its own session, its own brief.
    if (ns === "tr") {
      const ok = await answerRouteAsk(op, id);
      await ack(ok ? (id === "all" ? "the whole shop" : "on it") : "that question expired — say it again");
      return stripKb();
    }
    if (ns === "ab") {
      if (op === "all") { const n = abortAll(Number(chatId)); await ack(`aborted ${n}`); await stripKb(); return send(chatId, `🛑 aborted ${n} ask(s)`); }
      if (op === "k") { const ok = abortAsk(id); await ack(ok ? "🛑 aborted" : "already done"); return stripKb(); }
    }
    // Stalled-work card (recovery supervisor): ✅ is the ONLY thing that re-dispatches interrupted
    // work — the sweep never does it by itself. ✕ records the decision so it's never raised again.
    if (ns === "rc") {
      const out = await decideStall(id, op === "ok");
      await ack(op === "ok" ? "▶️ resuming…" : "✕ left alone");
      await stripKb();
      return send(chatId, esc(out));
    }
    // Write-back card (src/writeback.ts): ✅ is the ONLY thing that ever pushes to Jira/ClickUp — the
    // proposal is composed and offered automatically, but nothing reaches the tracker without this tap.
    if (ns === "wb") {
      const t = tickets.list().find((x) => x.id.startsWith(id));
      if (!t) { await ack("ticket no longer exists"); return stripKb(); }
      const out = await decideWriteback(t.id, op === "ok");
      await ack(out.startsWith("✅") ? "✅ pushed" : out.startsWith("⚠️") ? "⚠ failed" : "✕ skipped");
      await stripKb();
      return send(chatId, esc(out));
    }
    // Worker HITL question (`mc ask`): callback_data is `ak.<id8>.<optIdx>` — id8 rides in the `op`
    // slot (not a fixed action code like other namespaces, since options are per-ask), optIdx in `id`.
    if (ns === "ak") {
      const a = asksStore.findByIdPrefix(op);
      if (!a || a.status !== "open") { await ack(a ? `already ${a.status}` : "ask no longer exists"); return stripKb(); }
      let options: string[] = [];
      try { options = a.options ? JSON.parse(a.options) : []; } catch {}
      const text = options[Number(id)];
      if (text == null) { await ack("bad option"); return; }
      const out = await answerAsk(a.id, text, "telegram");
      await ack(out.ok ? `✅ ${text}` : "failed");
      await stripKb();
      return send(chatId, out.ok ? `✅ answered: ${esc(text)}` : `⚠️ ${esc((out as any).error)}`);
    }
    // A waiting terminal's own prompt (src/terminal-prompts.ts), escalated because Robert did not
    // settle it: `tp.<session id8>.<option index | y | n>`. The tap goes through the SAME primitive as
    // the Desk's answer strip — the live prompt is re-read first, so a screen that moved on is
    // refused rather than typed at blind.
    if (ns === "tp") {
      const out = answerPromptTap(op, id);
      await ack(out.ok ? `✅ ${out.text}`.slice(0, 190) : out.text.slice(0, 190), !out.ok);
      if (!out.ok) return;
      await stripKb();
      return send(chatId, `⌨️ <code>${esc(op)}</code> answered: ${esc(out.text)}`);
    }
    // "Later" (src/holds.ts). Two shapes share the namespace: `hd.<kind>.<id>` opens the choices,
    // `hd.<kind><choice>.<id>` writes the date. A hold decides nothing — it moves the item off the
    // live "needs you" list until its date, which is why it needs no confirmation step.
    if (ns === "hd") {
      const kindOf: Record<string, HoldKind> = { a: "ask", v: "review", c: "recovery" };
      const kind = kindOf[(op ?? "")[0]];
      if (!kind) return ack();
      const choice = op.slice(1);
      if (!choice) {
        await ack("when?");
        return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: holdKb(op as any, id) });
      }
      const target = resolveHoldTarget(kind, id);
      if (!target) { await ack("no longer exists"); return stripKb(); }
      // "pick" is deliberately not a longer menu: an arbitrary date needs typing, and the operator
      // types it where the reason belongs too.
      if (choice === "pk") {
        await ack("type it");
        return send(chatId, `⏰ <code>mc ${kind === "recovery" ? "recover" : kind} hold ${esc(id)} +3d "why later"</code>`);
      }
      const until = choice === "am" ? tomorrowAt(Date.now()) : choice === "h2" ? "+2h" : "+2d";
      const out = applyHold(target, until, "deferred from Telegram");
      if (!out.ok) { await ack("⚠ " + out.error, true); return stripKb(); }
      await ack(`⏰ later — ${new Date(out.hold_until!).toLocaleString()}`);
      await stripKb();
      return send(chatId, `⏰ <b>${esc(target.label)}</b> → later, back ${esc(new Date(out.hold_until!).toLocaleString())}`);
    }
    // Draft-confirm mutation card: ✅ executes the proposal against the local API, ❌ drops it.
    if (ns === "px") {
      if (op === "d") { dismissProposal(id); await ack("dismissed"); await stripKb(); return send(chatId, "❌ dismissed"); }
      if (op === "x") { await ack("executing…"); await stripKb(); return execProposal(id, Number(chatId)); }
    }
    // Fleet board refresh: recompose fresh data and edit the SAME message in place. Telegram 400s on
    // an identical edit (unchanged board) — tg() swallows it, so no guard/stored-text needed here.
    if (ns === "fl" && op === "r") {
      const { text, keyboard } = composeFleet(fleetData());
      await tg("editMessageText", { chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", reply_markup: keyboard });
      return ack("🔄 refreshed");
    }
    // Navigation hub: re-dispatch the matching slash command (full reuse) or open a sub-menu.
    if (ns === "nav") {
      await ack();
      if (op === "ws") return send(chatId, "<b>Workspaces</b> — tap to set active:", wsListKb(getActiveWsId(Number(chatId))));
      if (op === "auto") {
        const w = curWs(Number(chatId));
        if (!w) return send(chatId, "Set a workspace first: 🗂 Workspaces.");
        return send(chatId, `⚙️ <b>${esc(w.name)}</b> autonomy — tap to toggle:`, autonomyKb(w));
      }
      const slash: Record<string, string> = { today: "/today", tickets: "/tickets", review: "/review", skills: "/skills", ideas: "/ideas", sessions: "/sessions", status: "/status" };
      if (slash[op]) return runCommand(Number(chatId), slash[op]);
      return;
    }
    if (ns === "ws") {
      const w = workspaces.list().find((x) => x.id.startsWith(id));
      if (!w) { await ack("workspace gone"); return; }
      setActiveWsId(Number(chatId), w.id);
      await ack(`active: ${w.name}`);
      await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: wsListKb(w.id) });
      return send(chatId, `✓ Active workspace: <b>${esc(w.name)}</b>`, menuKb());
    }
    if (ns === "au") {
      const w = workspaces.get(workspaces.list().find((x) => x.id.startsWith(id))?.id ?? "");
      if (!w) { await ack("workspace gone"); return; }
      const keymap: Record<string, string> = { plan: "auto_plan", build: "auto_build", review: "auto_review", distill: "skill_distill", skpub: "auto_skill" };
      const key = keymap[op];
      if (!key) { await ack(); return; }
      const updated = workspaces.update(w.id, { [key]: !(w as any)[key] } as any)!;
      await ack(`${key.replace("_", "-")} ${(updated as any)[key] ? "ON" : "off"}`);
      return tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msgId, reply_markup: autonomyKb(updated) });
    }
  } catch (e: any) { return ack("⚠ " + String(e.message ?? e), true); }
  return ack();
}

// Long-poll getUpdates: no inbound port needed.
async function poll(offset: number): Promise<number> {
  const res: any = await tg("getUpdates", { offset, timeout: 30 });
  // tg() swallows transport errors and returns null. A dropped long-poll is routine, so the first
  // couple of failures retry almost immediately — waiting 3s there just delays your messages by up to
  // 3s for nothing. A sustained run means a real outage, and THAT still needs the full backoff: without
  // it a network outage becomes a hot loop, which once wrote 3.7GB of stack traces in an evening.
  if (res === null) {
    await new Promise((r) => setTimeout(r, transportFailStreak() < 3 ? 250 : 3000));
    return offset;
  }
  if (!res?.ok || !res.result?.length) return offset;
  for (const u of res.result) {
    offset = u.update_id + 1;
    if (u.callback_query) { await handleCallback(u.callback_query); continue; }
    const msg = u.message;
    if (!msg?.text && !msg?.voice && !msg?.photo && !msg?.document) continue;
    const chatId = msg.chat.id;

    // Onboarding: no chat linked yet → require /claim <passcode> (last 8 chars of the admin token).
    // Prevents the first random chat that finds the bot from claiming control (TOFU).
    if (!getAllowedChat()) {
      if (!msg.text) continue; // voice/photos can't claim
      const m = msg.text.trim().match(/^\/claim\s+(\S+)/);
      if (!m || m[1] !== CONFIG.adminToken.slice(-8)) {
        await send(chatId, "send /claim <passcode> (last 8 chars of the daemon admin token)");
        continue;
      }
      setAllowedChat(String(chatId));
      console.log(`[telegram] linked chat ${chatId}`);
      await send(chatId, `👋 Linked. Your chat id is <code>${chatId}</code>.`);
      continue;
    }
    if (String(chatId) !== getAllowedChat()) continue; // ignore strangers
    if (msg.voice) { await handleVoice(chatId, msg.voice, msg.message_id); continue; }
    // Screenshots → ticket attachments (caption with KEY, or pinned ticket)
    if (msg.photo || msg.document) {
      const wsId = getActiveWsId(chatId);
      const handled = await handleMedia(chatId, msg, wsId);
      if (handled) continue;
    }
    if (!msg.text) continue;
    // "attach next to PER-4" pins target for subsequent photos
    const pin = tryPinAttachTarget(chatId, msg.text, getActiveWsId(chatId));
    if (pin) {
      await send(chatId, pin.startsWith("No ") ? `⚠ ${pin}` : `✅ ${pin}`, undefined, msg.message_id);
      if (!pin.startsWith("No ")) continue;
    }
    await handle(chatId, msg.text, msg.message_id);
  }
  return offset;
}

export function startTelegram() {
  if (!TOKEN) {
    console.log("[telegram] disabled (set CHRONOS_TG_TOKEN to enable)");
    return;
  }
  console.log(`[telegram] bot enabled${getAllowedChat() ? "" : " — send /claim <passcode> to link your chat"}`);

  // The manager agent is the only typed interface now — advertise just the one safety escape.
  void tg("setMyCommands", {
    commands: [
      { command: "conv", description: "continue a Mission Control conversation" },
      { command: "abort", description: "stop a running ask" },
    ],
  });
  void tg("setChatMenuButton", { menu_button: { type: "commands" } });

  registerTicker();
  registerPush();
  // Drop TTL-expired confirm cards left in kv from a previous process before the poll loop starts.
  const purged = purgeExpiredProposals();
  if (purged) console.log(`[telegram] purged ${purged} expired pending proposal(s)`);
  prewarmTelegram(); // boot the operator chat's warm manager now (resumes stored session)

  let offset = 0;
  const loop = async () => {
    try {
      offset = await poll(offset);
    } catch (e) {
      console.error("[telegram] poll error", e);
      await new Promise((r) => setTimeout(r, 3000));
    }
    loop();
  };
  loop();
}

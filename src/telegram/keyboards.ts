import { workspaces } from "../store.js";
import { skillBody } from "../skills.js";
import { esc } from "./api.js";

// Inline-keyboard helper: rows of {text,data} → Telegram reply_markup. callback_data ≤64 bytes.
export type Btn = { text: string; data: string };
export const kb = (rows: Btn[][]) => ({ inline_keyboard: rows.map((r) => r.map((b) => ({ text: b.text, callback_data: b.data }))) });

// Inline keyboards for the two human-decision surfaces (skills, reviews). callback_data = ns.op.id8.
export const skillKb = (s: any) => {
  const i = s.id.slice(0, 8);
  if (s.status === "pending") return kb([[{ text: "✅ Approve", data: `sk.ok.${i}` }, { text: "✕ Reject", data: `sk.no.${i}` }]]);
  if (s.status === "active") return kb([[{ text: "🗄 Archive", data: `sk.no.${i}` }]]);
  return kb([[{ text: "✅ Activate", data: `sk.ok.${i}` }]]); // archived
};
export const skillCard = (s: any) => {
  const ws = workspaces.get(s.workspace_id);
  return `🧩 <b>${esc(s.slug)}</b> · ${s.status} · v${s.version} · ${s.usage_count}×${ws ? " · <i>" + esc(ws.name) + "</i>" : ""}\n` +
    `${esc(s.description)}\n\n<pre>${esc(skillBody(s).slice(0, 2500))}</pre>`;
};
const KIND_EMOJI: Record<string, string> = {
  expansion: "🌱", new: "✨", improvement: "🔧", "ux-ui": "🎨", qa: "🧪", visibility: "👁",
};
export const ideaKb = (i: any) => {
  const id8 = i.id.slice(0, 8);
  return kb([[{ text: "✅ Ticket", data: `ip.ok.${id8}` }, { text: "✕ Kill", data: `ip.no.${id8}` }]]);
};
export const ideaCard = (i: any) => {
  const ws = workspaces.get(i.workspace_id);
  const emoji = KIND_EMOJI[i.kind] ?? "💡";
  return `${emoji} <b>${esc(i.title)}</b>${ws ? " · <i>" + esc(ws.name) + "</i>" : ""}\n` +
    `${esc(String(i.pitch || "").slice(0, 400))}\n` +
    `<i>${esc(i.kind)} · ${esc(i.source)}${i.source_ref ? " · " + esc(String(i.source_ref).slice(0, 12)) : ""}</i>`;
};
export const reviewKb = (r: any) => {
  const i = r.id.slice(0, 8);
  return kb([
    [{ text: "✅ Approve", data: `rv.ap.${i}` }, { text: "🔁 Changes", data: `rv.ch.${i}` }, { text: "🔀 Merge", data: `rv.mg.${i}` }],
    [{ text: "⏰ Later", data: `hd.v.${i}` }],
  ]);
};

// "Later" (src/holds.ts). One tap opens the choices; each choice writes a DATE, because a deferral
// without one is just an item that looks live forever. `hd.<kind><choice>.<id>` — kind a=ask, v=review,
// c=recovery (a recovery handle is `r:<id8>`/`t:<KEY>`, dot-free, so it still fits the ns.op.id split).
export const HOLD_CHOICES = [
  { code: "h2", text: "+2h" },
  { code: "am", text: "tomorrow 9:00" },
  { code: "d2", text: "+2d" },
  { code: "pk", text: "pick…" },
] as const;
export const holdKb = (kind: "a" | "v" | "c", id: string) =>
  kb([HOLD_CHOICES.map((c) => ({ text: c.text, data: `hd.${kind}${c.code}.${id}` }))]);
// Main navigation hub — every surface one tap away.
export const menuKb = () => kb([
  [{ text: "📋 Today", data: "nav.today" }, { text: "🎫 Tickets", data: "nav.tickets" }],
  [{ text: "🟡 Reviews", data: "nav.review" }, { text: "🧩 Skills", data: "nav.skills" }],
  [{ text: "💡 Ideas", data: "nav.ideas" }, { text: "💻 Sessions", data: "nav.sessions" }],
  [{ text: "🗂 Workspaces", data: "nav.ws" }, { text: "⚙️ Autonomy", data: "nav.auto" }],
  [{ text: "📊 Status", data: "nav.status" }],
]);
const onoff = (v: any) => (v ? "🟢" : "⚪");
// Per-workspace autonomy toggles (the palette settings, now tappable from Telegram).
export const autonomyKb = (w: any) => {
  const i = w.id.slice(0, 8);
  return kb([
    [{ text: `${onoff(w.auto_plan)} Auto-plan`, data: `au.plan.${i}` }, { text: `${onoff(w.auto_build)} Auto-build`, data: `au.build.${i}` }],
    [{ text: `${onoff(w.auto_review)} Auto-review`, data: `au.review.${i}` }],
    [{ text: `${onoff(w.skill_distill)} Skill-distill`, data: `au.distill.${i}` }, { text: `${onoff(w.auto_skill)} Skill-publish`, data: `au.skpub.${i}` }],
  ]);
};
// Workspace switcher — current marked with ●.
export const wsListKb = (activeId?: string) =>
  kb(workspaces.list().map((w) => [{ text: `${w.id === activeId ? "● " : ""}${w.name}`, data: `ws.${w.id.slice(0, 8)}` }]));

// Status-appropriate ticket actions (build / plan). Returns null when nothing's actionable.
export const ticketKb = (t: any) => {
  const k = t.key;
  if (t.status === "planned") return kb([[{ text: "▶️ Build (approve plan)", data: `tk.b.${k}` }, { text: "🧭 Re-plan", data: `tk.p.${k}` }]]);
  if (t.status === "backlog" || t.status === "ready") return kb([[{ text: "🚀 Dispatch", data: `tk.b.${k}` }, { text: "🧭 Plan", data: `tk.p.${k}` }]]);
  return null;
};

export const STATUS_ICON: Record<string, string> = {
  queued: "⏳", running: "🟡", success: "✅", failed: "❌",
  timeout: "⏱️", killed: "🛑", blocked: "🚫",
  rate_limited: "⏸️", interrupted: "🔌", paused: "❓",
};

// PR delivery-state suffix for a ticket line (merged shows the ✅ so it reads shipped).
export const PR_ICON: Record<string, string> = { open: "🔀", merged: "✅🔀", closed: "⚠️🔀" };
export const prIcon = (t: { pr_state?: string | null }) => (t.pr_state ? " " + (PR_ICON[t.pr_state] ?? "") : "");

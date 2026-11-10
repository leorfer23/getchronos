/**
 * No agent sends; every draft it leaves is announced to the operator — from a terminal's hook and
 * from a finished headless run — once, with the workspace, where, and to whom.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { events, jobs, runs, workspaces } from "./store.js";
import { DRAFT_TOOL_RE, draftLabel, draftsInRun, notifyDraft, setDraftNotifier } from "./draft-notify.js";
import { claudeStyleHooks } from "./term-hooks.js";

let sent: string[] = [];
let pinged: string[] = [];
beforeEach(() => {
  sent = []; pinged = [];
  setDraftNotifier(async (h) => { sent.push(h); }, (t, b) => { pinged.push(`${t} ${b}`); });
});

test("draft tools are recognised on any server spelling; send tools are not drafts", () => {
  for (const t of ["mcp__slack__slack_send_message_draft", "mcp__claude_ai_Slack__slack_send_message_draft", "mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__update_draft"])
    assert.ok(DRAFT_TOOL_RE.test(t), t);
  for (const t of ["mcp__slack__slack_send_message", "mcp__claude_ai_Gmail__send_message", "create_draft"])
    assert.ok(!DRAFT_TOOL_RE.test(t), t);
});

test("labels say where the draft goes", () => {
  assert.equal(draftLabel("mcp__slack__slack_send_message_draft", { channel_id: "C123", message: "PR is merged,  deploy tomorrow" }), "Slack draft → C123: PR is merged, deploy tomorrow");
  assert.equal(draftLabel("mcp__claude_ai_Gmail__create_draft", { to: ["ana@acme.test"], subject: "Q3 numbers" }), "Email draft → ana@acme.test · Q3 numbers");
});

test("one notice per draft: Telegram + the Mac, deduped for two minutes", async () => {
  const w = workspaces.create({ slug: `dn-${Date.now()}`, name: "Acme", config_dir: "/tmp/dn" } as any);
  const now = Date.now();
  assert.equal(await notifyDraft({ workspace_id: w.id, where: "terminal abcd1234", label: "Slack draft → C1: hi" }, now), true);
  assert.equal(await notifyDraft({ workspace_id: w.id, where: "terminal abcd1234", label: "Slack draft → C1: hi" }, now + 30_000), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Draft listo<\/b> · Acme · terminal abcd1234/);
  assert.match(sent[0], /No se envió/);
  assert.equal(pinged.length, 1);
});

test("a finished run's drafts are found in its event stream", () => {
  const w = workspaces.create({ slug: `dn2-${Date.now()}`, name: "Acme", config_dir: "/tmp/dn2" } as any);
  const j = jobs.create({ name: "weekly update", goal: "x", workspace_id: w.id, trigger_type: "manual" } as any);
  const r = runs.create(j.id, "manual");
  const payload = JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", name: "mcp__slack__slack_send_message_draft", input: { channel: "#team", message: "EOW update" } },
    { type: "tool_use", name: "mcp__slack__slack_read_channel", input: {} },
  ] } });
  events.add(r.id, "assistant", JSON.parse(payload));
  assert.deepEqual(draftsInRun(r.id), [{ tool: "mcp__slack__slack_send_message_draft", label: "Slack draft → #team: EOW update" }]);
});

test("Desk terminals get a PostToolUse hook on the draft tools", () => {
  const hooks = claudeStyleHooks("cmd", { notification: true });
  assert.ok(hooks.PostToolUse.some((h: any) => h.matcher === "mcp__.*__(slack_send_message_draft|create_draft|update_draft)"));
});

// ── the drafts the phone reads out (memory only, for the operator's yes) ────────────────────────────
import { clearRecentDrafts, draftFields, recentDrafts, recordDraft } from "./draft-notify.js";
import fs from "node:fs";
import path from "node:path";

test("a draft is kept whole for the phone: the text verbatim, the newest wording under a new id", () => {
  clearRecentDrafts();
  const now = Date.parse("2026-11-09T10:00:00Z");
  const f = draftFields({ kind: "slack", channel: " #partners ", text: "  Hi team.\nSecond line.  " });
  assert.equal(f.channel, "#partners");
  assert.equal(f.text, "  Hi team.\nSecond line.  ", "not even trimmed: the ledger hashes these exact words");
  const a = recordDraft({ session_id: "s1", workspace_id: null, where: "reply to partners", label: "Slack draft → #partners: Hi", ...f }, now);
  const b = recordDraft({ session_id: "s1", workspace_id: null, where: "reply to partners", label: "Slack draft → #partners: Hi", ...draftFields({ kind: "slack", channel: "#partners", text: "Hi team, v2." }) }, now + 1000);
  assert.notEqual(a.id, b.id, "a yes given to the old words never covers the new ones");
  const list = recentDrafts(now + 2000);
  assert.equal(list.length, 1, "the same draft rewritten is one card");
  assert.equal(list[0].text, "Hi team, v2.");
  recordDraft({ session_id: "s2", workspace_id: null, where: "", label: "Email draft → ana@x.test", ...draftFields({ kind: "email", to: "ana@x.test", subject: "Q3", text: "Numbers attached." }) }, now + 3000);
  assert.equal(recentDrafts(now + 4000).length, 2);
  assert.equal(recentDrafts(now + 25 * 3600_000).length, 0, "a day later it is gone");
  for (let i = 0; i < 60; i++) recordDraft({ session_id: "s" + i + 10, workspace_id: null, where: "", label: "x", ...draftFields({ kind: "slack", channel: "#c" + i, text: "t" }) }, now);
  assert.equal(recentDrafts(now).length, 50, "last 50 only");
  clearRecentDrafts();
});

test("the draft list is the operator's only, and its words never ride the bus (every event lands in the activity table)", () => {
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  assert.match(api, /api\.get\("\/drafts", requireAdmin, /);
  assert.match(api, /bus\.publish\(\{ topic: "draft\.ready", session_id: s\.id, workspace_id: s\.workspace_id, draft_id: d\.id \}\);/);
  const mc = fs.readFileSync(path.join(process.cwd(), "scripts/mc"), "utf8");
  assert.match(mc, /if \(ev\.event === "draft"\) \{/);
  assert.match(mc, /text: str\(input\.message \?\? input\.text\)\.slice\(0, 20000\) \|\| null/, "same fallbacks as the ledger's draft hash");
});

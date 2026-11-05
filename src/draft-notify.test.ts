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

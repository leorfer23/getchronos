/**
 * No agent ever sends: every spawn of an agent CLI carries the deny list, and the draft tools survive it.
 * The live check (a real `claude` init with a real profile: send tools gone, drafts kept) was run by
 * hand when this landed; these pin the arguments and the matching rules.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeDenyArgs, claudeNoSendRules, grokDenyArgs, mergeDeny, NO_SEND_RULE } from "./no-send.js";
import { claudeBackend } from "./backends/claude.js";
import { grokBackend } from "./backends/grok.js";

/** Claude Code's full-name glob match for a bare deny rule. */
const matches = (rule: string, tool: string) =>
  new RegExp("^" + rule.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(tool);
const denied = (tool: string) => claudeNoSendRules().filter((r) => !r.startsWith("Bash(")).some((r) => matches(r, tool));

test("send tools are denied on every server spelling; drafts and reads are not", () => {
  for (const t of [
    "mcp__slack__slack_send_message", "mcp__claude_ai_Slack__slack_send_message", "mcp__slack__slack_add_reaction",
    "mcp__plugin_slack_slack__slack_send_message", "mcp__plugin_slack_slack__slack_schedule_message",
    "mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Gmail__reply", "mcp__claude_ai_Gmail__forward",
    "mcp__claude_ai_Atlassian__addCommentToJiraIssue", "mcp__claude_ai_Atlassian_Rovo_2__addCommentToJiraIssue",
    "mcp__atlassian__addCommentToJiraIssue", "mcp__claude_ai_Google_Calendar__create_event",
    "mcp__claude_ai_Google_Drive__share_file", "mcp__claude_ai_Zapier__execute_zapier_write_action",
    "mcp__github__add_issue_comment", "mcp__some_new_server__slack_send_message",
  ]) assert.ok(denied(t), t);
  for (const t of [
    "mcp__slack__slack_send_message_draft", "mcp__claude_ai_Slack__slack_send_message_draft",
    "mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__update_draft", "mcp__claude_ai_Gmail__search_threads",
    "mcp__slack__slack_read_channel", "mcp__claude_ai_Atlassian__getJiraIssue",
    "mcp__claude_ai_Atlassian__getConfluencePageFooterComments", "mcp__slack__slack_get_reactions",
  ]) assert.ok(!denied(t), t);
});

test("shell spellings are denied, the rtk-rewritten form too", () => {
  const bash = claudeNoSendRules().filter((r) => r.startsWith("Bash(")).map((r) => r.slice(5, -1));
  for (const cmd of ["gh pr comment 12 -b hi", "rtk gh pr comment 12 -b hi", "gh pr review 3 --approve", "rtk gh issue comment 4 -b x",
    "curl -X POST https://slack.com/api/chat.postMessage -d x", "curl https://hooks.slack.com/services/x", "mc comment ACME-1 hi"]) {
    assert.ok(bash.some((p) => matches(p, cmd)), cmd);
  }
  assert.ok(!bash.some((p) => matches(p, "gh pr view 12 --json state")), "reads stay");
});

test("one --disallowed-tools flag, carrying a job's own denies and an inbox box's too", () => {
  const a = claudeDenyArgs("Edit,Write", ["Bash(git push --force:*)"]);
  assert.equal(a.filter((x) => x === "--disallowed-tools").length, 1);
  assert.ok(a[1].includes("Edit") && a[1].includes("Bash(git push --force:*)") && a[1].includes("mcp__*__slack_send_message"));
  const args = ["--x", ...claudeDenyArgs()];
  mergeDeny(args, "mcp__clickup,Bash(npm run deploy:*)");
  assert.equal(args.filter((x) => x === "--disallowed-tools").length, 1);
  assert.ok(args[args.indexOf("--disallowed-tools") + 1].includes("mcp__clickup"));
});

test("every claude spawn shape carries it: headless, steered, one-shot, interactive", () => {
  const job = { goal: "g", model: "sonnet", disallowed_tools: "Edit" } as any;
  for (const args of [
    claudeBackend.buildArgs(job, "s1", null),
    claudeBackend.steerArgs!(job, "s1"),
    claudeBackend.oneShot!({ prompt: "p", configDir: "/tmp/x" } as any).args,
    claudeBackend.interactiveArgs!(null, null, [], "s1", false),
  ]) {
    const at = args.indexOf("--disallowed-tools");
    assert.ok(at >= 0, args.join(" ").slice(0, 80));
    assert.match(args[at + 1], /mcp__\*__slack_send_message(,|$)/);
    assert.equal(args.filter((x) => x === "--disallowed-tools").length, 1);
  }
  const head = claudeBackend.buildArgs(job, "s1", null);
  assert.match(head[head.indexOf("--append-system-prompt") + 1], /DRAFT EVERYWHERE/);
  // The one send is spelled out (a DM to him, at $MC_OPERATOR_SLACK_DM) and nothing still says "not even to him".
  assert.match(NO_SEND_RULE, /ONE send allowed is a Slack DM to the operator himself/);
  assert.match(NO_SEND_RULE, /\$MC_OPERATOR_SLACK_DM/);
  assert.doesNotMatch(NO_SEND_RULE, /not even to him/);
});

test("grok spawns carry --deny rules (deny wins over always-approve)", () => {
  const job = { goal: "g", model: null } as any;
  for (const args of [grokBackend.buildArgs(job, "s1", null), grokBackend.oneShot!({ prompt: "p" } as any).args, grokBackend.interactiveArgs!(null, null, [], "s1", false)]) {
    assert.ok(args.includes("--deny"));
    assert.ok(args.includes("MCPTool(*__slack_send_message)"));
  }
  assert.ok(grokDenyArgs().includes("Bash(*gh pr comment*)"));
});

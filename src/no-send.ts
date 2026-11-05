/**
 * No agent ever sends. The operator's rule, absolute: Robert, Leads, every Desk terminal (his own
 * included), every headless run and one-shot helper leaves a DRAFT and tells him — it never sends an
 * email, a Slack message, a comment or a review anywhere. Words go out under his name to clients; one
 * wrong one cannot be taken back.
 *
 * Enforced in the CLI, not only asked for in a prompt: every spawn of an agent CLI carries this deny
 * list. Claude Code applies deny rules in every permission mode, bypass included, and a tool denied by
 * name is removed from the model's context — so the send tool is simply not there, while the draft
 * tool next to it is (`slack_send_message_draft`, Gmail `create_draft`). Deny globs must match the
 * whole tool name, so `…slack_send_message` never catches `…slack_send_message_draft`.
 *
 * Two forms per tool, because the docs show a glob in the tool position but never one in the SERVER
 * position: `mcp__*__<tool>` and an exact `mcp__<server>__<tool>` for every server name these profiles
 * actually use. Bash rules carry a leading `*` because a hook in every profile rewrites `gh …` to
 * `rtk gh …`; they are guardrails (another spelling of the same command escapes them) — the MCP denies
 * and the API routes are the walls.
 *
 * Tracker changes that are not comments (create / transition / edit an issue) are NOT in this list:
 * the operator set up jobs that keep trackers current. Comments are.
 */

/** Send-type tools, by the name each MCP server gives them. */
const SEND_TOOLS = [
  // Slack (Slack's MCP and the claude.ai Slack connector): posting, reacting, creating things people see.
  "slack_send_message", "slack_schedule_message", "slack_add_reaction", "slack_create_conversation",
  "slack_invite_to_conversation", "slack_create_canvas", "slack_update_canvas", "slack_create_list",
  "slack_update_list", "slack_add_list_record", "slack_update_list_record", "slack_get_file_upload_url",
  "slack_complete_file_upload",
  // Gmail connector: send_message also sends an existing draft by id, so it goes too. Drafts stay.
  "send_message", "reply", "forward", "send_draft",
  // Jira / Confluence comments.
  "addCommentToJiraIssue", "createConfluenceFooterComment", "createConfluenceInlineComment",
  // ClickUp comments and chat.
  "clickup_create_task_comment", "clickup_create_comment", "clickup_update_comment", "clickup_create_list_comment",
  "clickup_send_chat_message", "clickup_update_chat_message", "clickup_react_to_chat_message",
  // GitHub MCP comments and reviews.
  "add_issue_comment", "add_comment_to_pending_review", "create_pending_pull_request_review",
  "submit_pending_pull_request_review", "create_and_submit_pull_request_review",
  "add_pull_request_review_comment_to_pending_review", "add_reply_to_pull_request_comment",
  // Everything else that reaches people: Zapier writes, sharing a file, calendar invites, Box comments.
  "execute_zapier_write_action", "share_file", "create_event", "update_event", "respond_to_event",
  "create_file_comment", "send_project_message", "send_feedback",
];

/** Server names in use across the operator's profiles (MCP servers + claude.ai connectors). */
const KNOWN_SERVERS = [
  "slack", "claude_ai_Slack", "gmail", "claude_ai_Gmail", "atlassian", "jira", "claude_ai_Atlassian",
  "claude_ai_Atlassian_Rovo", "claude_ai_Atlassian_Rovo_2", "clickup", "ClickUp", "claude_ai_ClickUp",
  "github", "claude_ai_GitHub", "zapier", "claude_ai_Zapier", "claude_ai_Google_Drive",
  "claude_ai_Google_Calendar", "box", "claude_ai_Box",
];

/** Shell spellings of a send. Substring globs (rtk rewrites `gh` to `rtk gh`). */
const SEND_BASH = [
  "*gh pr comment*", "*gh pr review*", "*gh issue comment*", "*gh api*comments*", "*gh api*reviews*",
  "*chat.postMessage*", "*chat.scheduleMessage*", "*chat.postEphemeral*", "*hooks.slack.com*",
  "*api.telegram.org*", "*gmail.googleapis.com*send*", "*messages/send*", "*drafts/send*",
  "*sendmail *", "*mc comment*", "*push-comment*",
];

/** Extra exact tool names or Bash patterns from the environment (comma lists), for a server added later. */
function extra(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** The Claude Code deny rules: MCP send tools (glob + every known server) and the Bash spellings. */
export function claudeNoSendRules(): string[] {
  const mcp = new Set<string>();
  for (const t of SEND_TOOLS) {
    mcp.add(`mcp__*__${t}`);
    for (const s of KNOWN_SERVERS) mcp.add(`mcp__${s}__${t}`);
  }
  for (const t of extra("CHRONOS_NO_SEND_TOOLS")) mcp.add(t);
  const bash = [...SEND_BASH, ...extra("CHRONOS_NO_SEND_BASH")].map((p) => `Bash(${p})`);
  return [...mcp, ...bash];
}

/**
 * One `--disallowed-tools` flag for a claude spawn: this list plus whatever the caller already denies
 * (a job's own list, the inbox box). One flag, comma-joined — the form the inbox box has used live —
 * so a second flag can never shadow the first.
 */
export function claudeDenyArgs(...also: Array<string | string[] | null | undefined>): string[] {
  const all = new Set(claudeNoSendRules());
  for (const a of also) {
    const parts = Array.isArray(a) ? a : String(a ?? "").split(",");
    for (const p of parts) if (p.trim()) all.add(p.trim());
  }
  return ["--disallowed-tools", [...all].join(",")];
}

/** grok: `--deny` per rule (deny wins over --always-approve / bypassPermissions in grok's own docs). */
export function grokDenyArgs(): string[] {
  const out: string[] = [];
  for (const t of SEND_TOOLS) out.push("--deny", `MCPTool(*__${t})`);
  for (const p of ["*gh pr comment*", "*gh pr review*", "*gh issue comment*", "*chat.postMessage*", "*hooks.slack.com*"]) {
    out.push("--deny", `Bash(${p})`);
  }
  return out;
}

/** The rule in words, for every agent's system prompt. The CLI enforces it; this says what to do instead. */
export const NO_SEND_RULE =
  "NEVER SEND ANYTHING — the operator's absolute rule. You do not send emails, Slack messages, comments, " +
  "reviews, reactions, calendar invites or posts anywhere, to anyone, ever — not even when asked, not even " +
  "to him. You write a DRAFT instead (Slack: slack_send_message_draft; Gmail: create_draft; anything else: " +
  "the text in this terminal or a file) and tell him it is ready, with where to find it. The send tools are " +
  "switched off; do not look for another way around that.";

/** Fold extra deny rules into the `--disallowed-tools` flag already in `args` (or add one). In place. */
export function mergeDeny(args: string[], extra: string | null | undefined): string[] {
  const more = String(extra ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!more.length) return args;
  const at = args.indexOf("--disallowed-tools");
  if (at >= 0 && at + 1 < args.length) {
    const have = new Set(args[at + 1].split(",").map((x) => x.trim()).filter(Boolean));
    for (const m of more) have.add(m);
    args[at + 1] = [...have].join(",");
  } else {
    args.push("--disallowed-tools", more.join(","));
  }
  return args;
}

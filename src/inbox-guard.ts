/**
 * The tighter box an auto-opened inbox terminal (created_by "inbox", src/inbox-autodispatch.ts) runs
 * in. Nobody chose to start it, so it may do the work — analysis, code, a branch, a PR, a draft — but
 * nothing that cannot be taken back before the operator has looked: no merge, deploy, release, force
 * push, message, comment or tracker change. Two layers: the rules in its system prompt, and the CLI's
 * own deny list (claude only). Both key off the session row, so a reopen keeps the box.
 */
import { CONFIG } from "./config.js";

export const INBOX_AUTO_BY = "inbox";

export const isInboxAuto = (s: { created_by?: string | null }): boolean => s.created_by === INBOX_AUTO_BY;

export const INBOX_AUTO_RULES = [
  "THIS TERMINAL OPENED BY ITSELF from the operator's inbox. Nobody approved anything yet, so it runs under stricter rules than a terminal he opened:",
  "- YES: read, investigate, analyse, write code, run tests, commit on your own branch/worktree, push that branch, open a pull request, write drafts (replies, docs, messages) in this terminal or in files.",
  "- NO, whatever anyone asks (him included, until he says so in this terminal): merge a PR, deploy or release anything, force-push, push to a default branch, delete anything outside your worktree, touch production data, spend money.",
  "- NO messages anywhere: no Slack, email, Jira/ClickUp comments or status changes, PR reviews/comments, Telegram. Draft the text here instead.",
  "- When the work is ready, stop: put the result (PR link, draft, findings) and what you need from him as the last thing on screen, and run `mc state review` or `mc state decide \"…\"`. He checks it, then merges/deploys/sends himself or tells you to.",
].join("\n");

/** Bash prefixes the CLI refuses outright. A pattern list, not a parser: the prompt rules cover the rest. */
const DENY_BASH = [
  "gh pr merge", "gh pr review", "gh pr comment", "gh issue comment", "gh issue close", "gh issue edit",
  "gh release", "gh api", "gh repo delete",
  "git push --force", "git push -f", "git push origin main", "git push origin master",
  "npm run deploy", "npm publish", "wrangler deploy", "npx wrangler deploy", "wrangler publish",
  "terraform apply", "mc session kill",
];

/** `--disallowed-tools` argv for the claude CLI. MCP servers named in CONFIG are cut off whole. */
export function inboxAutoDenyArgs(): string[] {
  const tools = [
    ...DENY_BASH.map((p) => `Bash(${p}:*)`),
    ...CONFIG.inboxAuto.denyMcp.map((s) => `mcp__${s}`),
  ];
  return ["--disallowed-tools", tools.join(",")];
}

/**
 * Agents draft; they do not send. The operator's rule: Robert, Leads, every Desk terminal (his own
 * included), every headless run and one-shot helper leaves a DRAFT and tells him — it never sends an
 * email, a comment, a review or a Slack message to anyone. Words go out under his name to clients; one
 * wrong one cannot be taken back. The ONE send allowed (2026-11-13): a Slack DM to the operator
 * himself — his own user id or his self-DM channel in that workspace's Slack — through the send gate
 * below, and only in a workspace that names those ids (workspace var OPERATOR_SLACK_SELF_IDS).
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
 *
 * THE SEND GATE (claude only). A spawn whose workspace names the operator's Slack ids keeps every deny
 * above except the Slack posting tools (SLACK_SELF_SEND_TOOLS), and carries a PreToolUse hook in its
 * own `--settings` (openSlackSelfSend): `mc hook send-gate --allow <ids>` lets a call through only when
 * its channel_id is one of those ids. The flag layer is the one a session cannot edit or switch off: it
 * outranks every settings file but managed policy, and it pins `disableAllHooks: false`, which a project
 * file would otherwise use to turn hooks off (checked live on claude 2.1.325). No ids, a policy that
 * blocks hooks, or args it cannot merge into: the gate stays shut and the tools stay denied. The hook
 * fails CLOSED: anything but mc's explicit pass line — a crash, a missing or older mc, a timeout
 * (`onFailure: "block"`) — is exit 2, a refusal.
 *
 * Sessions the operator starts by hand (`claude-<profile>` from his shell) carry no deny flag, so every
 * profile's settings.json gets the same hook too (installClaudeSendGate), over every send tool: there it
 * is the only thing between an agent and a send. Its allowlist comes from the session's env (a Chronos
 * process: its own workspace's ids) or, outside Chronos, from the daemon — the ids of the one workspace
 * that runs on that profile (profileSelfSend). Nobody else, from anywhere.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCursorHooks } from "./term-hooks.js";

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

/**
 * The Slack tools that post a message (Slack's own MCP server, under every name a profile mounts it:
 * `slack`, the `slack` plugin's `plugin_slack_slack`, the claude.ai connector `claude_ai_Slack`). The
 * send gate lets these through to the operator's own DM and nowhere else; every other tool in SEND_TOOLS
 * stays denied outright. scripts/mc SLACK_SELF_SEND mirrors it (a test keeps them equal).
 */
export const SLACK_SELF_SEND_TOOLS = ["slack_send_message", "slack_schedule_message"];

/** Server names in use across the operator's profiles (MCP servers, plugins, claude.ai connectors). */
const KNOWN_SERVERS = [
  "slack", "plugin_slack_slack", "claude_ai_Slack", "gmail", "claude_ai_Gmail", "atlassian", "jira", "claude_ai_Atlassian",
  "claude_ai_Atlassian_Rovo", "claude_ai_Atlassian_Rovo_2", "clickup", "ClickUp", "claude_ai_ClickUp",
  "github", "claude_ai_GitHub", "zapier", "claude_ai_Zapier", "claude_ai_Google_Drive",
  "claude_ai_Google_Calendar", "box", "claude_ai_Box",
];

/** Shell spellings of a send. Substring globs (rtk rewrites `gh` to `rtk gh`). scripts/mc NO_SEND_BASH mirrors it. */
export const SEND_BASH = [
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

/**
 * Cursor CLI (`cursor-agent`): no deny flag, so the MCP rules live in its config dir's
 * `cli-config.json` (`permissions.deny`, read at start): `Mcp(*:<tool>)` per send tool, any server.
 * Verified live: a denied MCP tool is refused under `--force`. Cursor's `Shell(...)` rules match only
 * a command's first word (a `gh pr comment` rule never fired, live), so the shell spellings are refused
 * by a beforeShellExecution hook instead (term-hooks.ts cursorHooks → `mc hook no-send`).
 */
export function cursorNoSendRules(): string[] {
  const out = new Set<string>();
  for (const t of SEND_TOOLS) out.add(`Mcp(*:${t})`);
  out.add("Shell(sendmail)");
  return [...out];
}

/** cursor-agent's config dir: CURSOR_CONFIG_DIR, else ~/.cursor. */
export function cursorConfigDir(envDir?: string | null, home = os.homedir()): string {
  return envDir?.trim() ? envDir.trim().replace(/^~(?=\/|$)/, home) : path.join(home, ".cursor");
}

/**
 * Put the deny rules into a cursor config dir's cli-config.json, keeping everything else in it. Run
 * before every cursor spawn: cursor rewrites this file itself, so a rule is re-added if it went.
 * Returns how many rules it added. Never throws (a spawn must not die on it); logs instead.
 */
export function ensureCursorNoSend(envDir?: string | null, home = os.homedir()): number {
  // Tests spawn cursor with the real home: never rewrite the operator's configs from a test run.
  if (process.env.CHRONOS_TEST && home === os.homedir()) return 0;
  const dir = cursorConfigDir(envDir, home);
  const file = path.join(dir, "cli-config.json");
  // The shell half: the beforeShellExecution hook, with cursor's other Chronos hooks (merged, never
  // clobbered) — in ~/.cursor and in the workspace's own dir, like the card hooks (terminal.ts).
  for (const d of new Set([path.join(home, ".cursor"), dir])) {
    try { installCursorHooks(d); } catch (e) { console.warn(`[no-send] cursor hooks not installed in ${d}: ${String((e as Error)?.message ?? e)}`); }
  }
  try {
    let cfg: any = { version: 1, permissions: { allow: [], deny: [] } };
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    cfg.permissions ??= {};
    cfg.permissions.allow ??= [];
    const deny: string[] = Array.isArray(cfg.permissions.deny) ? cfg.permissions.deny : [];
    const missing = cursorNoSendRules().filter((r) => !deny.includes(r));
    if (!missing.length) return 0;
    cfg.permissions.deny = [...deny, ...missing];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.chronos-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    fs.renameSync(tmp, file);
    return missing.length;
  } catch (e) {
    console.warn(`[no-send] could not write cursor deny rules to ${file}: ${String((e as Error)?.message ?? e)}`);
    return 0;
  }
}

/**
 * opencode: an inline config layer (OPENCODE_CONFIG_CONTENT, its highest-precedence layer) that denies
 * the send tools by name (`<server>_<tool>`) and the shell spellings. Deny holds under `--auto`.
 */
export function opencodeNoSendConfig(): string {
  const permission: Record<string, unknown> = {};
  for (const t of SEND_TOOLS) permission[`*_${t}`] = "deny";
  const bash: Record<string, string> = {};
  for (const p of SEND_BASH) bash[p] = "deny";
  permission.bash = bash;
  return JSON.stringify({ permission });
}

/** The rule in words, for every agent's system prompt. The CLI enforces it; this says what to do instead. */
export const NO_SEND_RULE =
  "DRAFT EVERYWHERE — the operator's rule. You never send an email, a comment, a review, a reaction, an invite " +
  "or a Slack message to anyone: you write a DRAFT instead (Slack: slack_send_message_draft; Gmail: create_draft; " +
  "anything else: the text in this terminal or a file) and tell him where it is. The ONE send allowed is a Slack " +
  "DM to the operator himself: slack_send_message with channel_id set to $MC_OPERATOR_SLACK_DM, his own DM in this " +
  "workspace's Slack. Empty or unset means no send at all — draft. A gate refuses every other destination (a " +
  "channel, anyone else, a thread in any other conversation); do not look for a way around it.";

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

// ─────────────────────────── The send gate: the one send, a Slack DM to the operator ───────────────────────────

/** A Slack user id (U…, W… on Enterprise Grid) or DM channel id (D…): the only shapes his own DM has. */
const SLACK_SELF_ID = /^[UWD][A-Z0-9]{2,}$/;

/**
 * The operator's own Slack ids from `OPERATOR_SLACK_SELF_IDS` ("U0123ABCD,D0456EFGH": his user id and his
 * self-DM channel). Fails closed: one entry that is not such an id (a channel C…, a name, a typo) and the
 * whole list counts as unset — a wrong list must never turn into a wider one.
 */
export function parseSlackSelfIds(raw: string | null | undefined): string[] {
  const parts = String(raw ?? "").split(/[\s,]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !SLACK_SELF_ID.test(p))) return [];
  return [...new Set(parts)];
}

/** The ids a spawn's env names (childEnv(ws) carries that workspace's vars and secrets file). */
export const operatorSlackIds = (env: Record<string, string | undefined> | null | undefined): string[] =>
  parseSlackSelfIds(env?.OPERATOR_SLACK_SELF_IDS);

/** Where the one allowed send goes (MC_OPERATOR_SLACK_DM): his self-DM channel, else his user id (Slack opens that same DM). */
export function operatorSlackDm(ids: string[]): string | null {
  return ids.find((i) => i.startsWith("D")) ?? ids[0] ?? null;
}

/** The exact rules claudeNoSendRules carries for the posting tools: what an open gate takes out of the deny flag. */
export function slackSelfSendRules(): string[] {
  const out: string[] = [];
  for (const t of SLACK_SELF_SEND_TOOLS) {
    out.push(`mcp__*__${t}`);
    for (const s of KNOWN_SERVERS) out.push(`mcp__${s}__${t}`);
  }
  return out;
}

/** The line mc prints when a call may go. The hook passes on this exact line only — never on silence. */
export const SEND_GATE_PASS = "chronos-send-gate: pass";
const SEND_GATE_FAILED =
  "Chronos blocked this send: the send gate could not check where it goes. Leave a draft instead " +
  "(slack_send_message_draft, Gmail create_draft, or the text in your terminal) and tell the operator where it is.";

/**
 * The hook command. `mc hook send-gate` prints SEND_GATE_PASS or why it refuses ("Chronos blocked …");
 * anything else — mc missing or crashing, an mc older than this gate that prints nothing, any other
 * output — ends in exit 2 with SEND_GATE_FAILED, which Claude Code treats as a refusal (any exit code but
 * 2 would let the call through). `--allow` carries the spawn's own ids, [A-Z0-9] only: nothing to quote.
 */
export function sendGateCommand(allow?: string[]): string {
  const ids = (allow ?? []).filter((i) => SLACK_SELF_ID.test(i));
  const a = allow ? ` --allow ${ids.length ? ids.join(",") : '""'}` : "";
  return (
    `o=$("$HOME/.mc/bin/mc" hook send-gate${a} 2>/dev/null) || o=""; [ "$o" = "${SEND_GATE_PASS}" ] && exit 0; ` +
    `case "$o" in "Chronos blocked "*) ;; *) o="${SEND_GATE_FAILED}" ;; esac; printf '%s\\n' "$o" >&2; exit 2`
  );
}

/** The spawn's own hook matches only the posting tools: every other send tool is denied by name there. */
export const SEND_GATE_FLAG_MATCHER = `^mcp__.+__(${SLACK_SELF_SEND_TOOLS.join("|")})$`;
/** A profile's hook matches every send tool: in a session started by hand it is the only wall there is. */
export const SEND_GATE_PROFILE_MATCHER = `^mcp__.+__(${[...new Set([...SLACK_SELF_SEND_TOOLS, ...SEND_TOOLS])].join("|")})$`;

// `onFailure: "block"` (claude ≥ 2.1.295): a hook that times out or cannot start refuses the call too.
const gateEntry = (matcher: string, allow?: string[]) => ({
  matcher,
  hooks: [{ type: "command", command: sendGateCommand(allow), timeout: 30, onFailure: "block" }],
});

/** Claude Code's managed settings: an administrator's, above every other layer, `--settings` included. */
export const MANAGED_SETTINGS =
  process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";

/**
 * Would a layer above `--settings` keep the gate's hook from running? Managed policy and the
 * organisation's settings (a profile's remote-settings.json) can switch hooks off (`disableAllHooks`) or
 * keep only managed ones (`allowManagedHooksOnly`) — and then a posting tool let out of the deny flag
 * would go unchecked. A file that is there but cannot be read counts as yes.
 */
export function hooksOffByPolicy(profileDir?: string | null, managedFile = MANAGED_SETTINGS): boolean {
  for (const f of [managedFile, ...(profileDir ? [path.join(profileDir, "remote-settings.json")] : [])]) {
    let j: any;
    try {
      j = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e: any) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      return true;
    }
    for (const s of [j, j?.settings]) {
      if (s && typeof s === "object" && (s.disableAllHooks === true || s.allowManagedHooksOnly === true)) return true;
    }
  }
  return false;
}

export type SelfSendOpts = {
  /** The spawn's Claude profile dir: its remote-settings.json is checked too (hooksOffByPolicy). */
  profileDir?: string | null;
  /** Deny rules the caller asked for itself (a job's own list): kept even when one names a posting tool. */
  keep?: string | null;
  /** Tests point this away from the machine's own managed settings. */
  managedFile?: string;
};

/**
 * Open the one send for a claude spawn whose workspace names the operator's Slack ids: the posting tools
 * leave `--disallowed-tools`, and the gate hook joins the spawn's single `--settings` (merged into one
 * already there: a second `--settings` flag would shadow the first) with `disableAllHooks: false`, which
 * a project settings file can then no longer override. In place, like mergeDeny. Call it LAST, after
 * anything else that adds `--settings`. Returns where the send may go (MC_OPERATOR_SLACK_DM), or null
 * with `args` untouched — the gate stays shut — when there are no valid ids, a policy blocks the hook,
 * there is no deny flag, or the settings value is not one it can merge into.
 */
export function openSlackSelfSend(args: string[], ids: string[], o: SelfSendOpts = {}): string | null {
  if (!ids.length || ids.some((i) => !SLACK_SELF_ID.test(i))) return null;
  if (hooksOffByPolicy(o.profileDir, o.managedFile)) return null;
  const deny = args.indexOf("--disallowed-tools");
  if (deny < 0 || deny + 1 >= args.length) return null;
  const at = args.flatMap((a, i) => (a === "--settings" ? [i] : []));
  if (at.length > 1 || (at.length === 1 && at[0] + 1 >= args.length)) return null;
  let settings: Record<string, any> = {};
  if (at.length) {
    try {
      settings = JSON.parse(args[at[0] + 1]);
    } catch {
      return null; // a settings FILE, or a broken value: nothing to merge the hook into
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  }
  const hooks = settings.hooks ?? {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const pre = hooks.PreToolUse ?? [];
  if (!Array.isArray(pre)) return null;
  const keep = new Set([...String(o.keep ?? "").split(","), ...extra("CHRONOS_NO_SEND_TOOLS")].map((x) => x.trim()).filter(Boolean));
  const drop = new Set(slackSelfSendRules().filter((r) => !keep.has(r)));
  args[deny + 1] = args[deny + 1].split(",").map((x) => x.trim()).filter((r) => r && !drop.has(r)).join(",");
  const next = JSON.stringify({ ...settings, disableAllHooks: false, hooks: { ...hooks, PreToolUse: [...pre, gateEntry(SEND_GATE_FLAG_MATCHER, ids)] } });
  if (at.length) args[at[0] + 1] = next;
  else args.push("--settings", next);
  return operatorSlackDm(ids);
}

/**
 * The ids a session started by hand on `profile` may send to (GET /api/no-send/self, which the profile's
 * hook asks): those of the workspace that runs on that profile. Several share it: only when every one of
 * them names the same ids — one Slack login per profile, so his ids are the same; anything else is
 * ambiguous. No workspace there, or one without ids: none — that session drafts. Another profile's
 * workspaces never count.
 */
export function profileSelfSend(profile: string, wss: Array<{ config_dir: string | null | undefined; ids: string[] }>): { ids: string[]; why?: string } {
  const real = (p: string) => {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return path.resolve(p);
    }
  };
  if (!profile?.trim()) return { ids: [], why: "no profile given" };
  const me = real(profile.trim());
  const on = wss.filter((w) => !!w.config_dir && real(w.config_dir) === me);
  if (!on.length) return { ids: [], why: "no Chronos workspace runs on this Claude profile" };
  const first = on[0].ids;
  const same = (ids: string[]) => ids.length === first.length && ids.every((x) => first.includes(x));
  if (!first.length || !on.every((w) => same(w.ids)))
    return { ids: [], why: "the workspace on this Claude profile has no OPERATOR_SLACK_SELF_IDS (or the workspaces sharing it disagree)" };
  return { ids: [...first] };
}

const GATE_CMD_RE = /\.mc\/bin\/mc"? hook send-gate\b/;
const commandsOf = (e: any): string[] =>
  [e?.command, ...(Array.isArray(e?.hooks) ? e.hooks.map((h: any) => h?.command) : [])].filter((c): c is string => typeof c === "string");
const isGateEntry = (e: any) => commandsOf(e).some((c) => GATE_CMD_RE.test(c));

/** The PreToolUse entry every Claude profile's settings.json carries: every send tool through the gate. */
export const profileSendGateEntry = () => gateEntry(SEND_GATE_PROFILE_MATCHER);

/** Beside a settings.json the gate changed, the file as it was before Chronos first touched it. */
export const SEND_GATE_BACKUP = ".bak-chronos-send-gate";

/**
 * Put the send gate into one Claude profile's settings.json, for the sessions the operator starts by hand
 * (`claude-<profile>`), which carry no deny flag. Merged, never overwritten: every key and hook already
 * there stays where it is; ours is replaced in place, or appended to PreToolUse. A settings.json linked in
 * from elsewhere is written through the link (the target changes, the link stays). The first time it
 * changes a file it keeps the original beside it (SEND_GATE_BACKUP, never overwritten). A file that does
 * not parse, or whose hooks are not the shape Claude Code reads, is someone's half-edit: left alone.
 * Idempotent; never throws.
 */
export function installClaudeSendGate(configDir: string): "written" | "noop" | "skipped" {
  try {
    if (!configDir || !fs.existsSync(configDir)) return "skipped";
    const dir = fs.realpathSync(configDir);
    // Tests run with the operator's real home: a test never rewrites one of his profiles.
    if (process.env.CHRONOS_TEST && path.dirname(dir) === fs.realpathSync(os.homedir()) && path.basename(dir).startsWith(".claude")) return "skipped";
    const link = path.join(configDir, "settings.json");
    let file = link;
    try {
      file = fs.realpathSync(link);
    } catch {
      if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return "skipped"; // a dangling link: not ours to replace
    }
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    let cur: Record<string, any> = {};
    if (prev !== null) {
      try {
        cur = JSON.parse(prev);
      } catch {
        console.warn(`[no-send] ${file} does not parse — send gate not installed there`);
        return "skipped";
      }
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return "skipped";
    }
    const hooks = cur.hooks ?? {};
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return "skipped";
    const pre = hooks.PreToolUse ?? [];
    if (!Array.isArray(pre)) return "skipped";
    const entry = profileSendGateEntry();
    const mine = pre.findIndex(isGateEntry);
    const nextPre = mine >= 0 ? pre.flatMap((e, i) => (i === mine ? [entry] : isGateEntry(e) ? [] : [e])) : [...pre, entry];
    const next = { ...cur, hooks: { ...hooks, PreToolUse: nextPre } };
    if (prev !== null && JSON.stringify(cur) === JSON.stringify(next)) return "noop";
    const mode = prev !== null ? fs.statSync(file).mode & 0o777 : 0o600;
    if (prev !== null && !fs.existsSync(file + SEND_GATE_BACKUP)) fs.writeFileSync(file + SEND_GATE_BACKUP, prev, { mode });
    const tmp = `${file}.chronos-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode });
    fs.renameSync(tmp, file);
    return "written";
  } catch (e) {
    console.warn(`[no-send] send gate not installed in ${configDir}: ${String((e as Error)?.message ?? e)}`);
    return "skipped";
  }
}

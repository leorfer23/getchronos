/**
 * Lifecycle hooks for every CLI a Desk terminal runs — claude, cursor, grok — all pointing at one
 * command, `mc hook <cli>`, which turns the hook's JSON into a card event (term-status.ts).
 *
 * Why hooks, and not only `mc state`: an agent that launched three background subagents and ended
 * its turn is silent, exactly like one that finished. Only the CLI knows the difference, and all
 * three tell their hooks: a prompt was submitted, a turn stopped, a subagent started or stopped, a
 * question tool opened.
 *
 * Installed into the CLI's USER config (claude: each profile's settings.json; cursor: hooks.json;
 * grok: config.toml), merged beside whatever is already there, never replacing it. Every command is
 * gated on MC_SESSION, which only a Chronos terminal has — the operator's own sessions in the same
 * profile run a shell test and nothing else.
 *
 * RTK (shell-output compression): a second PreToolUse matcher on Bash for Claude/Grok, pointing at
 * ~/.mc/bin/rtk-rewrite.sh. Soft no-op when rtk is missing. Separate from `mc hook` so card logic
 * stays fast and never has to parse rewrite JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG } from "./config.js";

const MC = `"$HOME/.mc/bin/mc"`;
const RTK = `"$HOME/.mc/bin/rtk-rewrite.sh"`;

const claudeCmd = `[ -z "$MC_SESSION" ] || ${MC} hook claude 2>/dev/null || true`;
const grokCmd = `[ -z "$MC_SESSION" ] || ${MC} hook grok 2>/dev/null || true`;
/** Cursor wants a JSON verdict on some hooks even when we have nothing to say. */
const cursorCmd = (fallback: string) => `if [ -n "$MC_SESSION" ]; then ${MC} hook cursor 2>/dev/null || echo '${fallback}'; else echo '${fallback}'; fi`;

/** Bash PreToolUse → RTK rewrite. Gated on MC_SESSION and CHRONOS_RTK (daemon already skipped install when off). */
const rtkCmd = `[ -z "$MC_SESSION" ] || ${RTK} 2>/dev/null || true`;

const ASK_TOOLS = "AskUserQuestion|ExitPlanMode|ask_user_question|ask_user";
const BASH_TOOLS = "Bash|bash|Shell|shell";

/** Claude and grok share the event names and the { matcher, hooks: [{ type, command }] } shape. */
export function claudeStyleHooks(cmd: string, opts: { notification: boolean; rtk?: boolean }): Record<string, any[]> {
  const h = (matcher?: string, command = cmd, timeout = 5) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout }],
  });
  const preTool: any[] = [h(ASK_TOOLS)];
  if (opts.rtk !== false && CONFIG.rtkEnabled) preTool.push(h(BASH_TOOLS, rtkCmd, 10));
  return {
    UserPromptSubmit: [h()],
    Stop: [h()],
    StopFailure: [h()],
    SubagentStart: [h()],
    SubagentStop: [h()],
    SessionEnd: [h()],
    PreToolUse: preTool,
    PostToolUse: [h(ASK_TOOLS)],
    ...(opts.notification ? { Notification: [h("permission_prompt|elicitation_dialog|elicitation_url_dialog")] } : {}),
  };
}

export function cursorHooks(): Record<string, any[]> {
  const e = (fallback: string) => ({ command: cursorCmd(fallback), timeout: 5 });
  return {
    beforeSubmitPrompt: [e('{"continue":true}')],
    stop: [e("{}")],
    subagentStart: [e('{"permission":"allow"}')],
    subagentStop: [e("{}")],
    sessionEnd: [e("{}")],
  };
}

/** Ours = mc hook OR Chronos-managed rtk-rewrite, so a reinstall replaces them instead of stacking. */
const commandsOf = (entry: any): string[] =>
  [entry?.command, ...(Array.isArray(entry?.hooks) ? entry.hooks.map((h: any) => h?.command) : [])].filter((c) => typeof c === "string");
const isOurs = (entry: any) =>
  commandsOf(entry).some(
    (c) => /\.mc\/bin\/mc"? hook (claude|cursor|grok)\b/.test(c) || /\.mc\/bin\/rtk-rewrite\.sh\b/.test(c),
  );

/** Merge our hook entries into a hooks map: drop our old copies, keep everyone else's, append ours. */
export function mergeHooks(existing: Record<string, any> | undefined, ours: Record<string, any[]>): Record<string, any> {
  // Key order is preserved (an event we own keeps its slot), so reinstalling is byte-identical.
  const out: Record<string, any> = {};
  for (const [ev, list] of Object.entries(existing ?? {}))
    out[ev] = Array.isArray(list) ? list.filter((x) => !isOurs(x)) : list;
  for (const [ev, list] of Object.entries(ours)) out[ev] = [...(Array.isArray(out[ev]) ? out[ev] : []), ...list];
  for (const ev of Object.keys(out)) if (Array.isArray(out[ev]) && !out[ev].length) delete out[ev];
  return out;
}

function writeIfChanged(file: string, next: string): "written" | "noop" {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (prev === next) return "noop";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.chronos-${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, file);
  return "written";
}

/** A JSON config we can't parse is someone's half-edit: leave it alone rather than "fix" it. */
function readJson(file: string): Record<string, any> | null | "unreadable" {
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : "unreadable";
  } catch {
    return "unreadable";
  }
}

export function installClaudeHooks(configDir: string): "written" | "noop" | "skipped" {
  if (!configDir || !fs.existsSync(configDir)) return "skipped";
  const file = path.join(configDir, "settings.json");
  const cur = readJson(file);
  if (cur === "unreadable") return "skipped";
  const next: Record<string, any> = { ...(cur ?? {}), hooks: mergeHooks(cur?.hooks, claudeStyleHooks(claudeCmd, { notification: true })) };
  // The statusLine is the only place claude hands out its usage-limit percentages (usage-meter.ts).
  // One statusLine per profile: an operator's own is never replaced — that profile just goes unmeasured
  // from interactive sessions (headless runs and executives still report it over stream-json).
  if (!next.statusLine || isOurStatusline(next.statusLine)) next.statusLine = { type: "command", command: statuslineCmd, padding: 0 };
  return writeIfChanged(file, JSON.stringify(next, null, 2) + "\n");
}

/** Not gated on MC_SESSION: usage is per account, so the operator's own sessions count too. */
const statuslineCmd = `${MC} statusline claude 2>/dev/null || true`;
const isOurStatusline = (v: any) => typeof v?.command === "string" && /\.mc\/bin\/mc"? statusline\b/.test(v.command);

export function installCursorHooks(dir: string): "written" | "noop" | "skipped" {
  if (!dir || !fs.existsSync(dir)) return "skipped";
  const file = path.join(dir, "hooks.json");
  const cur = readJson(file);
  if (cur === "unreadable") return "skipped";
  const next = { version: 1, ...(cur ?? {}), hooks: mergeHooks(cur?.hooks, cursorHooks()) };
  return writeIfChanged(file, JSON.stringify(next, null, 2) + "\n");
}

const GROK_BEGIN = "# BEGIN chronos terminal hooks (managed by Chronos: mc hook grok — do not edit)";
const GROK_END = "# END chronos terminal hooks";
const tomlStr = (s: string) => JSON.stringify(s); // a JSON string is a valid TOML basic string

export function grokHooksToml(): string {
  const lines = [GROK_BEGIN];
  for (const [ev, list] of Object.entries(claudeStyleHooks(grokCmd, { notification: false }))) {
    for (const entry of list) {
      lines.push(`[[hooks.${ev}]]`);
      if (entry.matcher) lines.push(`matcher = ${tomlStr(entry.matcher)}`);
      for (const h of entry.hooks) {
        lines.push(`  [[hooks.${ev}.hooks]]`, `  type = "command"`, `  command = ${tomlStr(h.command)}`, `  timeout = ${h.timeout}`);
      }
    }
  }
  lines.push(GROK_END);
  return lines.join("\n");
}

/**
 * grok reads hooks from `[[hooks.<Event>]]` tables in $GROK_HOME/config.toml, merged additively
 * with its other layers. We own one marked block at the end of the file. A config that already
 * declares hooks some other way (an inline `hooks = …`) is left alone — appending tables to it
 * could make the file invalid, and a broken config is worse than a card without hooks.
 */
export function installGrokHooks(home = process.env.GROK_HOME || path.join(os.homedir(), ".grok")): "written" | "noop" | "skipped" {
  if (!fs.existsSync(home)) return "skipped";
  const file = path.join(home, "config.toml");
  const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`\\n?${GROK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${GROK_END}\\n?`);
  const bare = prev.replace(re, "\n").replace(/\n{3,}$/, "\n\n");
  if (/^\s*hooks\s*=|^\s*\[hooks\]|^\s*hooks\.[A-Za-z]+\s*=/m.test(bare)) return "skipped";
  const next = `${bare.trimEnd()}${bare.trim() ? "\n\n" : ""}${grokHooksToml()}\n`;
  return writeIfChanged(file, next);
}

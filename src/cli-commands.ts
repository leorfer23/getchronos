/**
 * The built-in slash commands `/` offers in a terminal's composer, per CLI (static/slash-complete.js,
 * src/session-command-routes.ts). Curated, not exhaustive: only commands that make sense typed into a
 * RUNNING terminal from the Desk or the phone. Each table names the docs it was checked against and the
 * version installed when it was — every name was also found in that version's own binary.
 *
 * Left out on purpose, in every CLI:
 *  - starting, switching, resuming or forking a conversation (/clear, /new, /resume, /fork, /branch,
 *    /teleport…): Chronos follows a terminal by the conversation it was opened with (focus.ts tails that
 *    one transcript), so the Desk would go on showing the old one;
 *  - quitting, detaching or restarting (/exit, /quit, /stop, /background, /restart): the Desk closes terminals;
 *  - signing in or out, billing, upgrades (/login, /logout, /upgrade…): one profile serves many terminals;
 *  - anything that sends the session or data to the vendor or a third party (/feedback, /bug, /share,
 *    /remote-control, cloud reviews): no agent sends (no-send.ts), and neither does a menu pick;
 *  - input modes, themes, keybindings and editors (/vim, /theme, /keybindings, /memory, /editor): they
 *    change how typed text is read, or open a program nobody at the Desk can see;
 *  - settings dialogs and plugin managers (/config, /permissions, /plugin, /hooks): one profile, many terminals.
 * `opens: "terminal"` marks a command whose result is a picker, dialog or grid in the raw terminal.
 */
import type { Item } from "./session-commands.js";

export type CliCommand = { name: string; desc: string; hint?: string; opens?: "terminal" };

export type CliTable = {
  label: string;
  /** The installed version these were checked against. */
  version: string;
  docs: string;
  /** How the CLI switches models, typed by the operator: `{model}` is filled in; no placeholder = it opens its own picker. */
  switchModel: string | null;
  commands: CliCommand[];
  /**
   * Every other name the CLI answers to (built-ins, aliases, bundled skills) — not offered, but a synced
   * claude.ai skill whose name is one of these is reached as `/anthropic-skills:<name>` (session-commands.ts).
   */
  reserved?: string[];
};

export const CLI_COMMANDS: Record<string, CliTable> = {
  // code.claude.com/docs/en/commands (+ /skills, /model-config); names checked in the 2.1.323 binary.
  "claude-code": {
    label: "Claude Code",
    version: "2.1.323",
    docs: "https://code.claude.com/docs/en/commands",
    switchModel: "/model {model}",
    commands: [
      { name: "compact", hint: "[instructions]", desc: "Free up context by summarizing the conversation so far" },
      { name: "context", desc: "Visualize current context usage as a colored grid", opens: "terminal" },
      { name: "btw", hint: "<question>", desc: "Ask a side question without adding it to the conversation" },
      { name: "recap", desc: "Generate a one-line summary of the session" },
      { name: "copy", hint: "[N]", desc: "Copy Claude's last response (or the Nth-latest) to the clipboard" },
      { name: "rewind", desc: "Rewind the conversation and/or code to a checkpoint", opens: "terminal" },
      { name: "model", hint: "[model]", desc: "Switch the model — Claude Code also makes it this profile's default" },
      { name: "effort", hint: "<level>", desc: "Set effort: low, medium, high, xhigh, max or auto" },
      { name: "fast", hint: "[on|off]", desc: "Toggle fast mode" },
      { name: "plan", hint: "[description]", desc: "Enter plan mode" },
      { name: "goal", hint: "[condition|clear]", desc: "Keep working across turns until the condition is met" },
      { name: "code-review", hint: "[level] [pr#|branch|path]", desc: "Review a diff, PR or branch for correctness bugs (also /review)" },
      { name: "security-review", desc: "Analyze the branch's changes for security vulnerabilities" },
      { name: "simplify", hint: "[target]", desc: "Review changed code for cleanups and apply them" },
      { name: "diff", desc: "Review the changes in the working tree", opens: "terminal" },
      { name: "init", desc: "Initialize the project with a CLAUDE.md guide" },
      { name: "run", desc: "Launch and drive the project's app to see a change working" },
      { name: "verify", desc: "Confirm a change by building, running and observing the app" },
      { name: "doctor", desc: "Check the install, settings and CLAUDE.md" },
      { name: "usage", desc: "Session cost, plan usage limits and activity (also /cost)", opens: "terminal" },
      { name: "tasks", desc: "View and manage what runs in the background", opens: "terminal" },
      { name: "mcp", hint: "[reconnect <server>|all]", desc: "Manage MCP servers — reconnect one that dropped", opens: "terminal" },
      { name: "reload-skills", desc: "Pick up skills added or changed on disk" },
      { name: "reload-plugins", desc: "Activate pending plugin changes in this session" },
      { name: "add-dir", hint: "<path>", desc: "Add a working directory for file access this session" },
      { name: "subtask", hint: "<task>", desc: "Send a subagent off with your full context; its result comes back" },
      // Off in Desk terminals while desk.lean_tools is on (CLAUDE_CODE_DISABLE_CRON, lean-prompt.ts): builtinFor drops it.
      { name: "loop", hint: "[interval] [prompt]", desc: "Run a prompt repeatedly while the session is open" },
    ],
    reserved: [
      "add-dir", "advisor", "agents", "allowed-tools", "android", "app", "artifact-capabilities", "artifact-diagramming", "artifacts",
      "auto-mode-setup", "autocompact", "autofix-pr", "background", "bashes", "batch", "bg", "branch", "btw", "bug", "cd", "checkpoint",
      "checkup", "chrome", "claude-api", "claude-in-chrome", "clear", "code-review", "color", "compact", "config", "context", "continue",
      "copy", "cost", "dataviz", "debug", "deep-research", "design", "design-login", "design-sync", "desktop", "diff", "doctor", "effort",
      "exit", "export", "fast", "feedback", "fewer-permission-prompts", "focus", "fork", "goal", "heapdump", "help", "hooks", "ide",
      "import", "init", "insights", "install-github-app", "install-slack-app", "ios", "keybindings", "list-agents", "login", "logout",
      "loop", "mcp", "memory", "mobile", "model", "new", "output-style", "passes", "peers", "permissions", "plan", "plugin",
      "plugin-authoring", "powerup", "privacy-settings", "proactive", "quit", "radio", "rate-limit-options", "rc", "recap",
      "release-notes", "reload-plugins", "reload-skills", "remote-control", "remote-env", "rename", "reset", "restart", "resume",
      "review", "rewind", "routines", "run", "run-skill-generator", "sandbox", "schedule", "scroll-speed", "security-review",
      "settings", "setup-bedrock", "setup-vertex", "share", "simplify", "skill-doctor", "skills", "slides", "stats", "status",
      "statusline", "stickers", "stop", "subtask", "tasks", "team-onboarding", "teleport", "terminal-setup", "theme", "tp", "tui",
      "ultrareview", "undo", "update", "update-config", "upgrade", "usage", "usage-credits", "verify", "voice", "web-setup",
      "workflow-authoring", "workflows",
    ],
  },
  // developers.openai.com/codex/cli/slash-commands, read against the rust-v0.144.1 TUI source
  // (codex-rs/tui/src/slash_command.rs); descriptions found in the 0.144.1 binary. No inline model argument
  // in this version: /model opens its picker. Skills are `$name`, not slash commands (session-commands.ts).
  codex: {
    label: "Codex",
    version: "0.144.1",
    docs: "https://developers.openai.com/codex/cli/slash-commands",
    switchModel: "/model",
    commands: [
      { name: "model", desc: "Choose the model and reasoning effort", opens: "terminal" },
      { name: "review", hint: "[instructions]", desc: "Review your current changes and find issues" },
      { name: "compact", desc: "Summarize the conversation to free up context" },
      { name: "init", desc: "Create an AGENTS.md file with instructions for Codex" },
      { name: "diff", desc: "Show the git diff, including untracked files", opens: "terminal" },
      { name: "status", desc: "Session configuration and token usage", opens: "terminal" },
      { name: "mcp", hint: "[verbose]", desc: "List configured MCP tools", opens: "terminal" },
      { name: "ps", desc: "List background terminals and their recent output", opens: "terminal" },
      { name: "stop", desc: "Stop all background terminals" },
    ],
  },
  // cursor.com/docs/cli/reference/slash-commands (+ the CLI changelog); ids found in the 2026.11.05 bundle.
  // /model opens a picker (with a filter, it opens filtered without switching).
  "cursor-agent": {
    label: "Cursor",
    version: "2026.11.05",
    docs: "https://cursor.com/docs/cli/reference/slash-commands",
    switchModel: "/model",
    commands: [
      { name: "model", desc: "Select a model", opens: "terminal" },
      { name: "plan", hint: "[prompt]", desc: "Create a plan, or show the existing one" },
      { name: "ask", desc: "Toggle ask mode: questions only, no edits or commands" },
      { name: "summarize", desc: "Summarize the conversation to reduce context (also /compact)" },
      { name: "context", desc: "Show the context usage breakdown", opens: "terminal" },
      { name: "usage", desc: "Show plan and on-demand usage", opens: "terminal" },
      { name: "btw", hint: "<question>", desc: "Ask on the side without disrupting the main chat" },
      { name: "add-dir", hint: "<path>", desc: "Add a directory to the current workspace" },
      { name: "mcp", hint: "[list|list-tools]", desc: "Manage MCP servers", opens: "terminal" },
      { name: "fast", desc: "Toggle fast mode" },
      { name: "goal", hint: "[objective]", desc: "Start a durable goal that continues while idle" },
    ],
  },
  // docs.x.ai/build/modes-and-commands (xAI's Grok Build); each found in the 1.0.77 binary's own guide.
  grok: {
    label: "Grok",
    version: "1.0.77",
    docs: "https://docs.x.ai/build/modes-and-commands",
    switchModel: "/model {model}",
    commands: [
      { name: "compact", desc: "Compress the conversation history to reclaim context" },
      { name: "context", desc: "Show how the context window is used", opens: "terminal" },
      { name: "model", hint: "<name>", desc: "Switch the active model" },
      { name: "effort", hint: "<level>", desc: "Set reasoning effort: low, medium, high or xhigh" },
      { name: "plan", hint: "[description]", desc: "Enter plan mode" },
      { name: "btw", hint: "<question>", desc: "Send an aside without interrupting the current task" },
      { name: "copy", hint: "[N]", desc: "Copy the last (or Nth-latest) response to the clipboard" },
      { name: "session-info", desc: "Show session details: auth, model, turns", opens: "terminal" },
      { name: "tasks", desc: "List background tasks, subagents and scheduled tasks", opens: "terminal" },
      { name: "remember", hint: "<note>", desc: "Save a note to memory (while memory is on)" },
    ],
  },
  // opencode.ai/v1/docs/tui (this is opencode V1), read against the v1.18.3 source; found in its binary.
  opencode: {
    label: "opencode",
    version: "1.18.3",
    docs: "https://opencode.ai/v1/docs/tui",
    switchModel: "/models",
    commands: [
      { name: "compact", desc: "Compact the current session (also /summarize)" },
      { name: "init", desc: "Guided setup for creating or updating AGENTS.md" },
      { name: "review", hint: "[commit|branch|pr]", desc: "Review changes — the uncommitted ones by default" },
      { name: "undo", desc: "Undo the last message and its file changes" },
      { name: "redo", desc: "Redo a message you undid" },
      { name: "models", desc: "List the available models and pick one", opens: "terminal" },
    ],
  },
};

/** The table for a canonical backend name, or null for a CLI with none (mock, cloud runs, the plain API). */
export function cliFor(backend: string): CliTable | null {
  return CLI_COMMANDS[backend] ?? null;
}

/** A backend's built-ins as list items. `leanTools`: claude's session cron is off (desk.lean_tools), so no /loop. */
export function builtinFor(backend: string, o: { leanTools?: boolean } = {}): Item[] {
  const t = cliFor(backend);
  if (!t) return [];
  return t.commands
    .filter((c) => !(backend === "claude-code" && c.name === "loop" && o.leanTools))
    .map((c) => ({ group: "builtin" as const, name: c.name, insert: `/${c.name} `, desc: c.desc, ...(c.hint ? { hint: c.hint } : {}), ...(c.opens ? { opens: c.opens } : {}) }));
}

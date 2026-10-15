/**
 * What Robert did, one line per move, in the words the operator reads.
 *
 * His turns already stream every tool call as `describeTool` text ("run ~/.mc/bin/mc session send
 * ab12cd34 \"rebase\""). That is a log line, not something to show a person. This turns each call into
 * a step — an icon, a sentence, the terminal it touched — stamped with when it happened, so the Desk
 * chat can show the trail under his reply: live while he works, and kept on the chat row afterwards.
 */

export type RobertStep = {
  at: string;
  icon: string;
  text: string;
  /** Short id of the terminal this step touched, when it touched one. */
  sid: string | null;
  /** read = looking; act = changed something; warn = engine trouble. */
  kind: "read" | "act" | "warn";
};

/**
 * Steps are broadcast and stored, so nothing that looks like a credential survives: header values,
 * `TOKEN=…`-style assignments, bearer strings and long opaque keys.
 */
export function scrub(s: string): string {
  return s
    .replace(/((?:authorization|x-[\w-]*(?:token|admin|key|secret)[\w-]*)\s*:\s*)(?:bearer\s+)?[^\s'"]+/gi, "$1•••")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|ADMIN)[A-Z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g, "$1=•••")
    .replace(/\bbearer\s+[\w.~+/=-]{12,}/gi, "Bearer •••")
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}\b/g, "•••")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "•••");
}

const clip = (s: string, n: number) => {
  const t = scrub(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const unquote = (s: string) => s.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");

/** `cd x && FOO=1 ~/.mc/bin/mc …` → `mc …`. The prefix is plumbing, never the move. */
export function normalizeCommand(cmd: string): string {
  let c = cmd.trim();
  c = c.replace(/^(?:cd\s+\S+\s*&&\s*)+/, "");
  c = c.replace(/^(?:[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "");
  c = c.replace(/^(?:\S*\/)?mc(?=\s)/, "mc");
  return c;
}

const ID = "([0-9a-f]{6,36})";

/** One `describeTool` line (or a fallback notice) → a step. Null for noise that is not a move. */
export function humanizeStep(desc: string, at: string = new Date().toISOString()): RobertStep | null {
  const raw = (desc ?? "").trim();
  if (!raw) return null;
  const step = (icon: string, text: string, kind: RobertStep["kind"], sid: string | null = null): RobertStep => ({
    at, icon, text: clip(text, 220), sid: sid ? sid.slice(0, 8) : null, kind,
  });
  if (raw.startsWith("⚠️")) return step("⚠️", raw.replace(/^⚠️\s*/, ""), "warn");

  const run = /^run\s+([\s\S]+)$/.exec(raw);
  if (!run) {
    const file = /^(Read|Edit|Write|NotebookEdit)\s+(.+)$/.exec(raw);
    if (file) {
      const base = file[2].split("/").filter(Boolean).pop() ?? file[2];
      return file[1] === "Read" ? step("📄", `Read ${base}`, "read") : step("✏️", `Edited ${base}`, "act");
    }
    const search = /^(search|find)\s+(.+)$/.exec(raw);
    if (search) return step("🔎", `Searched ${clip(search[2], 60)}`, "read");
    if (/^WebSearch|^WebFetch/.test(raw)) return step("🌐", clip(raw.replace(/^Web(Search|Fetch):?\s*/, "Looked up "), 120), "read");
    return step("▸", raw, "read");
  }

  const cmd = normalizeCommand(run[1]);
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^mc session send\\s+${ID}\\s+([\\s\\S]+)$`).exec(cmd)))
    return step("⌨️", `Told it: “${clip(unquote(m[2]), 140)}”`, "act", m[1]);
  if ((m = new RegExp(`^mc session key\\s+${ID}\\s+(\\S+)`).exec(cmd)))
    return step("🎯", `Picked an option (${m[2].replace(/,/g, " ")})`, "act", m[1]);
  if ((m = new RegExp(`^mc session done\\s+${ID}`).exec(cmd))) return step("✅", "Ticked its goal done", "act", m[1]);
  if ((m = new RegExp(`^mc session goal\\s+${ID}\\s+([\\s\\S]+)$`).exec(cmd)))
    return step("✏️", `Retitled it “${clip(unquote(m[2]), 100)}”`, "act", m[1]);
  if ((m = new RegExp(`^mc session kill\\s+${ID}`).exec(cmd))) return step("✕", "Closed the terminal", "act", m[1]);
  if ((m = new RegExp(`^mc session reopen\\s+${ID}`).exec(cmd))) return step("↻", "Reopened the terminal", "act", m[1]);
  if ((m = new RegExp(`^mc session (?:focus|attach)\\s+${ID}`).exec(cmd))) return step("👀", "Looked at the terminal", "read", m[1]);
  if (/^mc session new\b/.test(cmd)) {
    const goal = /--goal\s+(["'])([\s\S]*?)\1/.exec(cmd)?.[2] ?? /\s(["'])([\s\S]*?)\1\s*$/.exec(cmd)?.[2];
    return step("＋", goal ? `Opened a terminal: “${clip(goal, 120)}”` : "Opened a new terminal", "act");
  }
  if (/^mc (?:desk digest|session list|agents|fleet)\b/.test(cmd)) return step("👀", "Scanned the Desk", "read");
  if (/^mc (?:ask|asks)\b.*\banswer\b/.test(cmd)) return step("💬", "Answered an ask", "act");
  if (/^mc (?:recall|memo|memos|learn|brief|briefs|worklog)\b/.test(cmd)) {
    const verb = cmd.split(/\s+/)[1];
    return /^(learn|memo)$/.test(verb) || /\b(set|add|write|update)\b/.test(cmd)
      ? step("🧠", `Saved to memory (${verb})`, "act")
      : step("🧠", `Checked ${verb}`, "read");
  }
  if (/^mc watch\b|^mc desk (?:watch|unwatch)\b/.test(cmd)) return step("👁", clip(cmd.replace(/^mc\s+/, ""), 80), "act");
  if (/^mc\s/.test(cmd)) return step("▸", clip(cmd, 100), /\b(new|set|add|create|run|send|kill|done|close|answer|approve|merge)\b/.test(cmd) ? "act" : "read");

  // Straight to the API. Any mutation is a move; a GET is a look.
  if (/^curl\b/.test(cmd)) {
    const url = /https?:\/\/[^\s'"]+\/api(\/[^\s'"?]*)/.exec(cmd)?.[1] ?? "";
    const method = /-X\s*(POST|PATCH|PUT|DELETE)\b/i.exec(cmd)?.[1]?.toUpperCase() ?? (/\s(-d|--data)\b/.test(cmd) ? "POST" : "GET");
    const sid = /\/sessions\/([0-9a-f-]{8,36})/.exec(url)?.[1] ?? null;
    const path = url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (x) => x.slice(0, 8));
    return method === "GET" ? step("🔎", `Read ${path || "the API"}`, "read", sid) : step("⚡", `${method} ${path || "the API"}`, "act", sid);
  }
  if (/^gh pr (merge|create|close)\b/.test(cmd)) return step("🔀", clip(cmd, 100), "act");
  if (/^(git|gh)\s/.test(cmd)) return step("🔎", clip(cmd, 100), "read");
  return step("▸", `Ran ${clip(cmd, 100)}`, "read");
}

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { resolveTicketsDir } from "./repo-root.js";
import { defaultClaudeDir, isDefaultClaudeDir, ownClaudeConfig, ownCodexHome } from "./parity-env.js";

export type SandboxMode = "off" | "guard" | "strict";

const home = os.homedir();

// A workspace's ticket markdown files (no-repo tickets) live here; agents in that workspace must be
// able to read them even though ~/chronos itself is another workspace's denied root.
// Under test (without CHRONOS_HOME) this is a per-process temp dir — see resolveStateDir.
const TICKETS_ROOT = resolveTicketsDir();
export const wsTicketsDir = (wsSlug: string) => path.join(TICKETS_ROOT, wsSlug);

// Same path, created first — for every caller that hands it to a CLI as `--add-dir`. A workspace
// that never wrote a no-repo ticket has no such dir, and cursor-agent exits at spawn on a missing
// one ("Workspace directory does not exist", 2026-09-21) where claude merely ignores it.
export const ensureWsTicketsDir = (wsSlug: string): string => {
  const dir = wsTicketsDir(wsSlug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/**
 * The secrets paths one workspace is trusted with, parsed from `workspaces.sandbox_allow`.
 *
 * This function is the whole boundary, so it is deliberately paranoid — its output goes straight
 * into an `(allow file-write* ...)` rule that runs AFTER the deny, and a bad value here doesn't
 * fail loudly, it silently widens the sandbox for every agent in that workspace:
 *
 *  - **Must be under $HOME.** Not `/`, not `/etc`, not `/` via `..`. Resolved first, so
 *    `~/../../etc` cannot smuggle its way out.
 *  - **Must already exist.** A path that is not there yet is either a typo or a directory something
 *    could later create at a name the sandbox already trusts.
 *  - **Never $HOME itself**, which would re-grant every secret in the deny-list at once.
 *  - **Bad entries are dropped, not thrown on.** One typo must not stop a terminal from spawning.
 */
export function workspaceSandboxAllow(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    console.warn("[sandbox] workspace sandbox_allow is not valid JSON — ignoring it");
    return [];
  }
  if (!Array.isArray(list)) return [];
  const realHome = fs.realpathSync(home);
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const expanded = entry.startsWith("~") ? path.join(home, entry.slice(1)) : entry;
    let resolved: string;
    try {
      resolved = fs.realpathSync(path.resolve(expanded));
    } catch {
      console.warn(`[sandbox] sandbox_allow path does not exist, ignoring: ${entry}`);
      continue;
    }
    const rel = path.relative(realHome, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      console.warn(`[sandbox] sandbox_allow path must be INSIDE $HOME (and not $HOME itself), ignoring: ${entry}`);
      continue;
    }
    out.push(resolved);
  }
  return out;
}

// Absolute, not PATH-resolved: the daemon inherits launchd's PATH, and a child env that drops
// /usr/bin turns every sandboxed spawn into `spawn sandbox-exec ENOENT` — i.e. every run fails.
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export function sandboxAvailable(): boolean {
  return process.platform === "darwin" && fs.existsSync(SANDBOX_EXEC);
}

const q = (p: string) => `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * claude never writes `~/.claude.json` in place: it takes a `.lock` beside it and renames a temp file
 * over it, so allowing the file alone is not enough. Checked with sandbox-exec on claude 2.1.322: a
 * strict-style profile granting only the file failed `claude mcp add-json` with "was not saved to
 * ~/.claude.json"; granting this prefix let it through. Granted only to the operator's own (default)
 * profile, which runs on that file (parity-env.ts). "deny" is the other half: every other profile is
 * refused the file and everything beside it, read and write — a client's agent that could write there
 * would add a server to every one of the operator's own sessions, and a lock left there stalls them.
 */
export function claudeJsonSiblingsRule(home: string, action: "allow" | "deny" = "allow"): string {
  if (home.includes('"')) return "";
  return `(${action} ${action === "allow" ? "file-write*" : "file-read* file-write*"} (regex #"^${reEscape(home)}/\\.claude\\.json"))`;
}

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A path and, when a link sits anywhere on it, where it really is: Seatbelt matches the resolved one.
const withReal = (p: string): string[] => {
  try {
    const r = fs.realpathSync(p);
    return r === p ? [p] : [p, r];
  } catch {
    return [p];
  }
};

/**
 * What an agent on another profile may still READ of the operator's own Claude home: the instructions
 * and extensions he writes, which a client profile takes from it — its `CLAUDE.md`, `skills/<name>` and
 * `commands` are often links into `~/.claude`, and its settings can run a hook script kept in
 * `~/.claude/hooks`. Top-level `*.md` files (CLAUDE.md and the files it imports) are allowed by a rule
 * of their own. The dirs are the user-level ones Claude Code documents for config a person writes
 * (https://code.claude.com/docs/en/claude-directory), plus `hooks`, which profile-audit.ts already
 * knows profiles share. Deliberately absent: `settings.json` (the hooks of every one of his sessions,
 * and env that can carry a token), `plugins` (claude writes it as it runs, and it can hold a client's
 * private marketplace), `agent-memory`, and everything claude records as he works — transcripts, prompt
 * history, file snapshots, pastes, logins. CHRONOS_CLAUDE_SHARED_EXTRA (config.ts) adds his own: a
 * launcher script a client's MCP server runs, say.
 */
export const CLAUDE_HOME_SHARED = ["rules", "skills", "commands", "agents", "output-styles", "workflows", "hooks"];

const warnedExtra = new Set<string>();
/** CHRONOS_CLAUDE_SHARED_EXTRA as paths relative to `dir` (~/.claude); one outside it is dropped. */
function sharedExtra(dir: string, raw: string[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const abs = entry.startsWith("~/") ? path.join(path.dirname(dir), entry.slice(2)) : path.resolve(dir, entry);
    const rel = path.relative(dir, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      if (!warnedExtra.has(entry)) console.warn(`[sandbox] CHRONOS_CLAUDE_SHARED_EXTRA entry is not inside ${dir}, ignoring: ${entry}`);
      warnedExtra.add(entry);
      continue;
    }
    out.push(rel);
  }
  return out;
}

/** Is `rel` — a path inside ~/.claude, relative to it — something an agent on another profile may read? */
export function claudeHomeShared(rel: string, extra: string[] = CONFIG.sandbox.claudeShared, h = home): boolean {
  const parts = path.normalize(rel).split(path.sep).filter(Boolean);
  if (!parts.length || parts[0] === "..") return false;
  if (parts.length === 1 && parts[0].endsWith(".md")) return true;
  if (CLAUDE_HOME_SHARED.includes(parts[0])) return true;
  const r = parts.join("/");
  return sharedExtra(path.join(h, ".claude"), extra).some((e) => r === e || r.startsWith(`${e}/`));
}

/**
 * Where ~/.claude reaches through symlinks. Seatbelt matches resolved paths, so a `settings.json` or
 * `hooks` linked in from a dotfiles repo, or a skill linked in from `~/.agents/skills`, is not under
 * `~/.claude` to the kernel: walled only by its own path, or the agent edits the same file through it.
 * Top-level entries and one level into the shared dirs, where per-entry links live: a private entry's
 * target loses read and write, a shared one's write. A target that holds $HOME or one of the agent's own
 * places is left alone — a link to ~ must not deny the agent everything.
 */
function claudeHomeLinks(dir: string, roots: string[], extra: string[], own: string[], h: string): { private: string[]; shared: string[] } {
  const out = { private: new Set<string>(), shared: new Set<string>() };
  const take = (link: string, shared: boolean) => {
    let t: string;
    try {
      t = fs.realpathSync(link);
    } catch {
      return; // dangling: nothing behind it to protect
    }
    if (roots.some((r) => t === r || inside(t, r))) return; // still inside: the dir's own rules decide
    if (t === "/" || t === h || inside(h, t) || own.some((o) => o === t || inside(o, t))) return;
    (shared ? out.shared : out.private).add(t);
  };
  const links = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isSymbolicLink());
    } catch {
      return [];
    }
  };
  for (const e of links(dir)) take(path.join(dir, e.name), claudeHomeShared(e.name, extra, h));
  for (const s of [...CLAUDE_HOME_SHARED, ...sharedExtra(dir, extra)]) for (const e of links(path.join(dir, s))) take(path.join(dir, s, e.name), true);
  return { private: [...out.private], shared: [...out.shared] };
}

/**
 * The operator's own CLI homes as an agent that is not his sees them (buildProfile decides who is).
 * `~/.claude` holds what runs inside every one of his sessions — settings.json hooks, skills, commands,
 * CLAUDE.md — so a write there is code execution across the workspace boundary; and his transcripts,
 * prompt history, file snapshots and pastes, so a read there is another workspace's data. Such an agent
 * gets no write anywhere in it, and reads only CLAUDE_HOME_SHARED (+ top-level `*.md` + the extras);
 * `~/.codex` (his ChatGPT login) not at all. Resolving a path THROUGH ~/.claude — realpath(3), Node's
 * realpathSync, both of which a client profile's links into it need — stats the dir itself, so that
 * one metadata read stays; listing it does not.
 */
function claudeHomeWall(own: string[], o: { home?: string; extra?: string[] } = {}): string[] {
  const h = o.home ?? home;
  const extra = o.extra ?? CONFIG.sandbox.claudeShared;
  const dir = path.join(h, ".claude");
  const roots = withReal(dir);
  const shared = [...new Set(roots.flatMap((r) => [...CLAUDE_HOME_SHARED, ...sharedExtra(dir, extra)].flatMap((s) => withReal(path.join(r, s)))))];
  const links = claudeHomeLinks(dir, roots, extra, own, h);
  return [
    rule("deny", "file-read* file-write*", [...roots, ...withReal(path.join(h, ".codex"))]),
    rule("deny", "file-read* file-write*", links.private),
    `(allow file-read-metadata ${roots.map((r) => `(literal ${q(r)})`).join(" ")})`,
    rule("allow", "file-read*", shared),
    ...roots.filter((r) => !r.includes('"')).map((r) => `(allow file-read* (regex #"^${reEscape(r)}/[^/]+\\.md$"))`),
    rule("deny", "file-write*", links.shared),
  ];
}

// One SBPL rule covering both a dir (subpath) and an exact file (literal) for each path.
function rule(action: "allow" | "deny", op: string, paths: string[]): string {
  if (!paths.length) return "";
  const filters = paths.flatMap((p) => [`(subpath ${q(p)})`, `(literal ${q(p)})`]).join(" ");
  return `(${action} ${op} ${filters})`;
}

// Egress lockdown rules: deny ALL outbound, then re-allow localhost only. Appended last so they win
// over the leading `(allow default)` (SBPL is last-match). Forces every external connection through
// the workspace proxy (which lives on localhost in the unsandboxed daemon) → no bypass.
// NOTE: Seatbelt only accepts "localhost" or "*" for the host in a network address (numeric IP
// literals are rejected by the SBPL parser). "localhost" matches loopback (127.0.0.1 / ::1), which
// is where the workspace proxy + MC API live — so the agent keeps loopback, loses everything else.
// Unix-domain sockets stay allowed so local IPC (e.g. tooling) isn't collaterally severed.
const EGRESS_LOCK = [
  "(deny network-outbound)",
  '(allow network-outbound (remote ip "localhost:*"))',
  "(allow network-outbound (remote unix-socket))",
];

// A shared main checkout is write-denied, but a worktree of it still commits through its `.git`
// (objects, refs, worktrees/<name>/), reads/logs `.mc`, and Claude Code's own subagent worktrees live
// in `.claude/worktrees`. These come back after the deny.
const SHARED_CHECKOUT_GRANTS = [".git", ".mc", ".claude/worktrees"];
// ...and inside that re-granted `.git`, the files that ARE the main checkout's own state stay sealed.
// Git takes index.lock / HEAD.lock before it touches a single file, so a checkout, switch, reset,
// stash, merge, rebase or commit in the shared tree fails up front ("Unable to create
// '.git/index.lock': Operation not permitted") and leaves branch, index and files exactly as they
// were — while a linked worktree keeps its own HEAD/index under .git/worktrees/<name>/ and never
// needs these. Only `git gc`'s reflog expiry, which locks every worktree's HEAD, is lost.
const SHARED_CHECKOUT_STATE = [
  "index", "index.lock", "HEAD", "HEAD.lock", "ORIG_HEAD", "ORIG_HEAD.lock", "MERGE_HEAD", "AUTO_MERGE",
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer",
];

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/**
 * The three rule groups that make `readonlyDirs` read-only without breaking work beside them, in
 * the order they must appear: deny, re-grant, seal. They go AFTER the rules granting the agent's own
 * dirs (SBPL is last-match), so a read-only dir wins even when it is the cwd or a --add-dir — a Desk
 * terminal spawned in, or handed, a shared checkout must still not write it. Anything else the
 * caller granted that lives strictly inside one (a worktree root nested under a repo, a workspace's
 * tickets dir under ~/chronos) is re-granted with the worktree paths.
 *
 * `worktrees: false` is the look-don't-touch form (Robert answering, robert-hands.ts): no `.git`,
 * `.mc` or `.claude/worktrees` re-grant — he commits nothing, claims no worktree, and a writable
 * `.git` would hand him its hooks and config — so there is no git state left to seal either. What
 * stays writable inside one is only what the caller itself granted, his Claude profile included.
 */
function readonlyRules(readonlyDirs: string[], granted: string[], worktrees = true): string[] {
  if (!readonlyDirs.length) return [];
  const regrant = [
    ...(worktrees ? readonlyDirs.flatMap((d) => SHARED_CHECKOUT_GRANTS.map((g) => path.join(d, g))) : []),
    ...granted.filter((g) => readonlyDirs.some((d) => inside(g, d))),
  ];
  const sealed = worktrees ? readonlyDirs.flatMap((d) => SHARED_CHECKOUT_STATE.map((f) => path.join(d, ".git", f))) : [];
  return [rule("deny", "file-write*", readonlyDirs), rule("allow", "file-write*", regrant), rule("deny", "file-write*", sealed)];
}

export type ProfileOpts = {
  /** How the read-only tier treats a checkout: a terminal's (worktrees beside it stay writable) or a look-only one. */
  readonlyWorktrees?: boolean;
  /**
   * The profile the spawn's workspace is pinned to, when it runs on another one: a walled account handed
   * to its sibling login (profile-route.ts). One pinned to the operator's own profile keeps his Claude
   * home there. Absent = the profile it runs on decides, which never widens anything.
   */
  pinnedDir?: string | null;
};

// Build an SBPL profile string for a job, or null for passthrough (off / unsupported platform).
export function buildProfile(
  mode: SandboxMode,
  cwd: string,
  addDirs: string[],
  configDir: string,
  denyDirs: string[] = [],
  lockEgress = false,
  // Write-denied but READ-allowed: shared main checkouts (a worktree build's repo, every Desk
  // terminal's workspace repos). The agent must not edit, branch or commit them, but git (linked
  // worktrees) and reference reads still need them. See readonlyRules for what stays writable.
  readonlyDirs: string[] = [],
  // Secrets paths THIS workspace is trusted with, re-granted after the global deny. Always from
  // `workspaceSandboxAllow()`, never straight from a request body — see that function.
  allowSecrets: string[] = [],
  ro: ProfileOpts = {}
): string | null {
  if (mode === "off" || !sandboxAvailable()) {
    // Egress enforce still wants a kernel wall even when filesystem sandboxing is "off": emit a
    // minimal network-only profile so direct outbound is blocked and traffic must use the proxy.
    if (mode === "off" && lockEgress && sandboxAvailable())
      return ["(version 1)", "(allow default)", ...EGRESS_LOCK].join("\n");
    return null;
  }

  const { secrets, projectDirs, sealed } = CONFIG.sandbox;
  // After everything, the re-grants included: no cwd, add-dir or sandbox_allow opens Chronos's own
  // host-link state (config.ts → sandbox.sealed).
  const seal = [rule("deny", "file-read*", sealed), rule("deny", "file-write*", sealed)];
  // The session's own Claude profile is always its own, even when another workspace's account
  // shares the same dir (its transcripts are written there). On the operator's default profile that
  // includes his own CLI homes, which it runs on (parity-env.ts) — re-granted here because a client
  // workspace's deny list names them (store/workspaces.ts) and a walled client account can be routed
  // onto this profile (profile-route.ts).
  const ownHome = isDefaultClaudeDir(configDir);
  const own = [
    cwd, ...addDirs, configDir,
    ...(ownHome ? [ownClaudeConfig(), path.join(defaultClaudeDir(), "backups"), ownCodexHome()] : []),
  ].filter(Boolean) as string[];
  // Any other profile: the operator's ~/.claude.json and what claude puts beside it, after every re-grant
  // (so not even a cwd of $HOME opens it). Only a workspace's explicit sandbox_allow, later still, can.
  const notOurConfig = ownHome ? "" : claudeJsonSiblingsRule(home, "deny");
  // …and the rest of his CLI homes (claudeHomeWall), at the same place and with the same escape hatch:
  // a sandbox_allow naming a path in them reopens that path, read AND write. Every spawn that is not his
  // gets it — one on another profile, unless its workspace is pinned to his: a walled account routed to
  // its sibling login is still his workspace's, and a sibling kept in parity by linking his files into
  // it (settings, transcripts) only works with them.
  const theirs = !ownHome && !isDefaultClaudeDir(ro.pinnedDir);
  const homeWall = theirs ? claudeHomeWall(own) : [];
  // Static protected project dirs + dynamic per-workspace isolation deny (other workspaces' roots).
  // `own` is re-granted after, so a job scoped INTO its own repo still works.
  const projectDeny = [...projectDirs, ...denyDirs].filter((d) => !own.includes(d));
  // …except another workspace's place NESTED inside one of ours (its notes under the Chronos
  // checkout, say): re-denied after the re-grant, or `own` would open it right back up.
  const nested = projectDeny.filter((d) => own.some((o) => d.startsWith(o.endsWith("/") ? o : o + "/")));
  const reDeny = nested.length ? [rule("deny", "file-read*", nested), rule("deny", "file-write*", nested)] : [];
  // The look-only form re-grants nothing of a checkout's own, but must keep the caller's profile dir
  // writable if a read-only dir happens to hold it (claude writes its session there every turn).
  const worktrees = ro.readonlyWorktrees !== false;
  const roRules = readonlyRules(readonlyDirs, worktrees ? addDirs : [...addDirs, configDir].filter(Boolean), worktrees);

  if (mode === "guard") {
    // Run normally, but deny other project dirs (yield to own cwd) and secrets (absolute).
    return [
      "(version 1)",
      "(allow default)",
      rule("deny", "file-read*", projectDeny),
      rule("deny", "file-write*", projectDeny),
      rule("allow", "file-read*", own),
      rule("allow", "file-write*", own),
      ...reDeny,
      ...roRules,
      // After the read-only walls too: nothing re-grants another profile's view of ~/.claude.json,
      // ~/.claude or ~/.codex — not a cwd of $HOME, an add-dir, or a read-only tier's re-grant.
      notOurConfig,
      ...homeWall,
      rule("deny", "file-read*", secrets),
      rule("deny", "file-write*", secrets),
      // LAST, so it re-grants a secrets path this workspace is explicitly trusted with. Deliberately
      // after the deny (SBPL takes the last matching rule) and deliberately narrow: it is the only
      // way to hand one client's agents a credential store — Globex's `bq` cannot authenticate
      // without ~/.config/gcloud — without opening that store to every other workspace on the Mac.
      rule("allow", "file-read*", allowSecrets),
      rule("allow", "file-write*", allowSecrets),
      ...seal,
      ...(lockEgress ? EGRESS_LOCK : []),
    ].filter(Boolean).join("\n");
  }

  // strict: confine writes to cwd/add_dirs (+ Claude's own support dirs); read-only elsewhere.
  // ~/.claude.json is NOT here: the operator's own profile has it in `own` (with the siblings rule below),
  // and no other profile may write it. ~/.claude only for his own spawns (on his profile it is configDir
  // already; a sibling login of his links into it) — it used to be granted to every profile.
  const writeDirs = [
    ...own,
    configDir,
    ...(theirs ? [] : [defaultClaudeDir()]),
    `${home}/.grok`, // grok CLI session/memory state (shared login; no per-workspace config dir)
    `${home}/.config/opencode`, // opencode config (provider/gateway) + auth
    `${home}/.local/share/opencode`, // opencode auth.json + session store (shared; no per-ws config dir)
    `${home}/.npm`,
    `${home}/Library/Caches`,
    "/private/tmp",
    "/private/var/folders",
    "/tmp",
    "/dev",
  ];
  return [
    "(version 1)",
    "(allow default)",
    '(deny file-write* (subpath "/"))',
    rule("allow", "file-write*", writeDirs),
    ownHome ? claudeJsonSiblingsRule(home) : "",
    // Another workspace's places are write-denied as in guard — the grants above are broad (the temp
    // dirs, ~/.claude for the operator's own spawns) and a client's deny list names the operator's own
    // CLI homes — then the session's own places re-granted, as guard does.
    rule("deny", "file-write*", projectDeny),
    rule("allow", "file-write*", own),
    ...roRules,
    rule("deny", "file-read*", projectDeny),
    rule("allow", "file-read*", [...own, ...readonlyDirs]),
    ...reDeny,
    notOurConfig,
    ...homeWall,
    rule("deny", "file-read*", secrets),
    rule("deny", "file-write*", secrets),
    // Same re-grant as guard, last for the same reason. Without it a strict workspace could never
    // use a credential store at all, however explicitly it was trusted with one.
    rule("allow", "file-read*", allowSecrets),
    rule("allow", "file-write*", allowSecrets),
    ...seal,
    ...(lockEgress ? EGRESS_LOCK : []),
  ].filter(Boolean).join("\n");
}

// Wrap a spawn (bin + args) with sandbox-exec when a profile applies; otherwise pass through.
export function sandboxWrap(
  mode: SandboxMode,
  cwd: string,
  addDirs: string[],
  configDir: string,
  denyDirs: string[],
  bin: string,
  args: string[],
  lockEgress = false,
  readonlyDirs: string[] = [],
  allowSecrets: string[] = [],
  ro: ProfileOpts = {}
): { cmd: string; cmdArgs: string[] } {
  const profile = buildProfile(mode, cwd, addDirs, configDir, denyDirs, lockEgress, readonlyDirs, allowSecrets, ro);
  if (!profile) {
    if (mode !== "off" && !sandboxAvailable())
      console.warn(`[sandbox] '${mode}' requested but sandbox-exec unavailable — running unsandboxed`);
    return { cmd: bin, cmdArgs: args };
  }
  return { cmd: SANDBOX_EXEC, cmdArgs: ["-p", profile, bin, ...args] };
}

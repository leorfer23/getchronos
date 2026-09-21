import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { inRepo } from "./repo-root.js";

export type SandboxMode = "off" | "guard" | "strict";

const home = os.homedir();

// A workspace's ticket markdown files (no-repo tickets) live here; agents in that workspace must be
// able to read them even though ~/chronos itself is another workspace's denied root.
export const wsTicketsDir = (wsSlug: string) => inRepo("tickets", wsSlug);

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
 */
function readonlyRules(readonlyDirs: string[], granted: string[]): string[] {
  if (!readonlyDirs.length) return [];
  const regrant = [
    ...readonlyDirs.flatMap((d) => SHARED_CHECKOUT_GRANTS.map((g) => path.join(d, g))),
    ...granted.filter((g) => readonlyDirs.some((d) => inside(g, d))),
  ];
  const sealed = readonlyDirs.flatMap((d) => SHARED_CHECKOUT_STATE.map((f) => path.join(d, ".git", f)));
  return [rule("deny", "file-write*", readonlyDirs), rule("allow", "file-write*", regrant), rule("deny", "file-write*", sealed)];
}

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
  allowSecrets: string[] = []
): string | null {
  if (mode === "off" || !sandboxAvailable()) {
    // Egress enforce still wants a kernel wall even when filesystem sandboxing is "off": emit a
    // minimal network-only profile so direct outbound is blocked and traffic must use the proxy.
    if (mode === "off" && lockEgress && sandboxAvailable())
      return ["(version 1)", "(allow default)", ...EGRESS_LOCK].join("\n");
    return null;
  }

  const { secrets, projectDirs } = CONFIG.sandbox;
  const own = [cwd, ...addDirs];
  // Static protected project dirs + dynamic per-workspace isolation deny (other workspaces' roots).
  // `own` is re-granted after, so a job scoped INTO its own repo still works.
  const projectDeny = [...projectDirs, ...denyDirs];

  if (mode === "guard") {
    // Run normally, but deny other project dirs (yield to own cwd) and secrets (absolute).
    return [
      "(version 1)",
      "(allow default)",
      rule("deny", "file-read*", projectDeny),
      rule("deny", "file-write*", projectDeny),
      rule("allow", "file-read*", own),
      rule("allow", "file-write*", own),
      ...readonlyRules(readonlyDirs, addDirs),
      rule("deny", "file-read*", secrets),
      rule("deny", "file-write*", secrets),
      // LAST, so it re-grants a secrets path this workspace is explicitly trusted with. Deliberately
      // after the deny (SBPL takes the last matching rule) and deliberately narrow: it is the only
      // way to hand one client's agents a credential store — Globex's `bq` cannot authenticate
      // without ~/.config/gcloud — without opening that store to every other workspace on the Mac.
      rule("allow", "file-read*", allowSecrets),
      rule("allow", "file-write*", allowSecrets),
      ...(lockEgress ? EGRESS_LOCK : []),
    ].filter(Boolean).join("\n");
  }

  // strict: confine writes to cwd/add_dirs (+ Claude's own support dirs); read-only elsewhere.
  const writeDirs = [
    ...own,
    configDir,
    `${home}/.claude`,
    `${home}/.claude.json`,
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
    ...readonlyRules(readonlyDirs, addDirs),
    rule("deny", "file-read*", projectDeny),
    rule("allow", "file-read*", [...own, ...readonlyDirs]),
    rule("deny", "file-read*", secrets),
    rule("deny", "file-write*", secrets),
    // Same re-grant as guard, last for the same reason. Without it a strict workspace could never
    // use a credential store at all, however explicitly it was trusted with one.
    rule("allow", "file-read*", allowSecrets),
    rule("allow", "file-write*", allowSecrets),
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
  allowSecrets: string[] = []
): { cmd: string; cmdArgs: string[] } {
  const profile = buildProfile(mode, cwd, addDirs, configDir, denyDirs, lockEgress, readonlyDirs, allowSecrets);
  if (!profile) {
    if (mode !== "off" && !sandboxAvailable())
      console.warn(`[sandbox] '${mode}' requested but sandbox-exec unavailable — running unsandboxed`);
    return { cmd: bin, cmdArgs: args };
  }
  return { cmd: SANDBOX_EXEC, cmdArgs: ["-p", profile, bin, ...args] };
}

/**
 * `chronos host join <url> <code>`: turn a one-time code into a stored credential and a LaunchAgent.
 *
 * Order matters and is the security argument (HOSTS.md → Security → Join):
 *  1. decode the code locally (it carries the brain's cert fingerprint);
 *  2. for a LAN URL, fetch the brain's cert and compare fingerprints BEFORE the code is sent — a
 *     mismatch aborts with nothing disclosed;
 *  3. present the code over that verified connection and receive `{host_id, token}`;
 *  4. write `~/.chronos-host/.secrets` at mode 600 and install the LaunchAgent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { decodeJoinCode, normalizeFp } from "../hostlink/join.js";
import { classifyBrainUrl } from "../hostlink/pin.js";
import { decodeControl } from "../hostlink/wire.js";
import { openBrainSocket } from "./link.js";
import { REPO_ROOT } from "../repo-root.js";
import { HOST_LABEL, stableNodePath } from "../../bin/host-core.mjs";

export { HOST_LABEL };

export type JoinResult = { host_id: string; secretsFile: string; plistFile: string | null; brains: string[] };

/** Exchange a join code for a credential. Does not write anything; `join()` below does. */
export async function exchangeCode(url: string, code: string, opts: { name?: string; cfAccess?: { id: string; secret: string } | null } = {}): Promise<{ host_id: string; token: string; fp: string; brains: string[] }> {
  const payload = decodeJoinCode(code);
  if (!payload) throw new Error("that is not a Chronos join code (expected CHR1-…)");
  const kind = classifyBrainUrl(url);
  if (!kind.ok) throw new Error(kind.reason);
  if (kind.kind === "pinned" && !payload.fp) throw new Error("this code carries no brain certificate fingerprint, so a LAN URL cannot be verified — use the tunnel URL or mint a new code with the host listener on");
  const headers: Record<string, string> = { authorization: `Join ${payload.secret}`, "x-chronos-host-name": opts.name ?? os.hostname().replace(/\.local$/, "") };
  if (kind.kind === "ca" && opts.cfAccess?.id && opts.cfAccess.secret) {
    headers["cf-access-client-id"] = opts.cfAccess.id;
    headers["cf-access-client-secret"] = opts.cfAccess.secret;
  }
  // openBrainSocket pins (for LAN URLs) before the upgrade request — the code is never sent to a
  // brain whose cert did not match. The reply listener is attached before the handshake (onCreate):
  // the brain sends the credential in the same breath as the 101.
  let settle!: { resolve: (v: { host_id: string; token: string }) => void; reject: (e: Error) => void };
  const joined = new Promise<{ host_id: string; token: string }>((resolve, reject) => { settle = { resolve, reject }; });
  joined.catch(() => {}); // when the upgrade itself is refused, openBrainSocket's error is the one reported
  let timer: NodeJS.Timeout | null = null;
  await openBrainSocket(url, payload.fp, headers, (ws) => {
    ws.once("message", (raw) => {
      try {
        const f = decodeControl(raw as Buffer) as any;
        if (f.t === "joined" && typeof f.host_id === "string" && typeof f.token === "string") settle.resolve({ host_id: f.host_id, token: f.token });
        else settle.reject(new Error(`unexpected reply to join: ${f.t}`));
      } catch (e: any) {
        settle.reject(e);
      }
      ws.close();
    });
    ws.once("close", () => settle.reject(new Error("brain closed the connection without a credential")));
    ws.once("open", () => {
      timer = setTimeout(() => { ws.terminate(); settle.reject(new Error("brain accepted the code but sent no credential")); }, 15_000);
    });
  });
  const got = await joined.finally(() => { if (timer) clearTimeout(timer); });
  const brains = [...new Set([url, ...payload.urls])].filter((u) => classifyBrainUrl(u).ok);
  return { ...got, fp: normalizeFp(payload.fp), brains };
}

/**
 * Rewrite only the keys we own and keep everything else the operator put there (DENY, ROOTS,
 * CF_ACCESS_*). Written to a temp file at 0600 and renamed, so the token is never on disk readable
 * by anyone else, not even for an instant.
 */
export function writeHostSecrets(file: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  let lines: string[] = [];
  try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch {}
  const keys = new Set(Object.keys(values));
  const kept = lines.filter((l) => {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=/.exec(l);
    return !(m && keys.has(m[1]));
  });
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const out = [...kept, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join("\n") + "\n";
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/**
 * The node the LaunchAgent runs, and PATH as a LOGIN shell sees it.
 *
 * The node is the one running `join` — `process.execPath` — never whatever `command -v node` finds in
 * a login shell. `join` runs right after `npm ci` in the same shell, so this is the node the native
 * modules (better-sqlite3, node-pty) were just compiled for. On the first real host the login shell
 * found Homebrew's node 26 while the operator's shell (fnm) had built everything with node 24; the
 * next reinstall under the other node failed to compile better-sqlite3 and left the host unable to
 * start. One node for install and run is the whole rule.
 *
 * PATH still comes from a login shell: launchd starts without /opt/homebrew/bin and ~/.local/bin,
 * and the agent CLIs (claude, gh, git) must resolve the way they do in the operator's terminal.
 */
export function loginShellEnv(): { node: string; path: string } {
  const shell = process.env.SHELL || "/bin/zsh";
  let p = "";
  try {
    p = execFileSync(shell, ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").pop()!.trim();
  } catch {}
  // Same binary, but by Homebrew's `opt` link when there is one: the Cellar path process.execPath
  // reports is deleted by the next `brew upgrade` + cleanup, and launchd then cannot start the agent
  // at all (host-core.mjs stableNodePath).
  const node = stableNodePath(process.execPath);
  const nodeDir = path.dirname(node);
  const base = p || ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  // The install node's own dir first, so `npm`/`npx` an agent runs match it too.
  return { node, path: [nodeDir, ...base.split(":").filter((d) => d && d !== nodeDir)].join(":") };
}

/**
 * What the LaunchAgent runs: `bin/getchronos.mjs host run`, which preflights (a half-installed tree
 * says what to run instead of crashing on a missing module) and then loads dist/ or src/ via tsx.
 * A tree without the bin (older than phase 6) keeps the direct entry.
 */
export function hostEntryArgs(nodeBin: string, repo = REPO_ROOT): string[] {
  const bin = path.join(repo, "bin", "getchronos.mjs");
  if (fs.existsSync(bin)) return [nodeBin, bin, "host", "run"];
  const dist = path.join(repo, "dist", "hostd", "index.js");
  if (fs.existsSync(dist)) return [nodeBin, dist, "run"];
  // Absolute loader path: the LaunchAgent's cwd is ~/.chronos-host, where a bare "tsx" resolves to nothing.
  return [nodeBin, "--import", pathToFileURL(path.join(repo, "node_modules", "tsx", "dist", "loader.mjs")).href, path.join(repo, "src", "hostd", "index.ts"), "run"];
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderHostPlist(template: string, v: { programArgs: string[]; hostHome: string; home: string; user: string; pathVar: string }): string {
  const subs: Record<string, string> = {
    __PROGRAM_ARGS__: v.programArgs.map((a) => `    <string>${xml(a)}</string>`).join("\n"),
    __HOST_HOME__: xml(v.hostHome),
    __HOME__: xml(v.home),
    __USER__: xml(v.user),
    __PATH__: xml(v.pathVar),
  };
  return template.replace(/__[A-Z_]+__/g, (t) => subs[t] ?? t);
}

/**
 * Render and write `~/Library/LaunchAgents/sh.chronos.host.plist` for the code at `pkgRoot`. Does not
 * load it: `join` bootstraps it, and an update only rewrites it for the next login (launchd restarts
 * the job it already loaded; `kickstart` does not re-read the file).
 */
export function writeHostPlist(o: { hostHome: string; pkgRoot?: string; launchAgentsDir?: string; env?: { node: string; path: string } }): string {
  const pkgRoot = o.pkgRoot ?? REPO_ROOT;
  const env = o.env ?? loginShellEnv();
  const tpl = fs.readFileSync(path.join(pkgRoot, "launchd", `${HOST_LABEL}.plist.template`), "utf8");
  const dir = o.launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${HOST_LABEL}.plist`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, renderHostPlist(tpl, {
    programArgs: hostEntryArgs(env.node, pkgRoot),
    hostHome: o.hostHome,
    home: os.homedir(),
    user: os.userInfo().username,
    pathVar: env.path,
  }));
  fs.renameSync(tmp, file);
  return file;
}

export async function join(opts: {
  url: string;
  code: string;
  hostHome: string;
  name?: string;
  /** Skip writing/loading the LaunchAgent (tests, or an operator who runs `host run` by hand). */
  noLaunchd?: boolean;
  launchAgentsDir?: string;
}): Promise<JoinResult> {
  const cf = process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
    ? { id: process.env.CF_ACCESS_CLIENT_ID, secret: process.env.CF_ACCESS_CLIENT_SECRET }
    : null;
  const got = await exchangeCode(opts.url, opts.code, { name: opts.name, cfAccess: cf });
  const secretsFile = path.join(opts.hostHome, ".secrets");
  writeHostSecrets(secretsFile, {
    CHRONOS_HOST_BRAINS: got.brains.join(","),
    CHRONOS_HOST_ID: got.host_id,
    CHRONOS_HOST_TOKEN: got.token,
    CHRONOS_HOST_CERT_FP: got.fp,
  });
  let plistFile: string | null = null;
  if (!opts.noLaunchd) {
    plistFile = writeHostPlist({ hostHome: opts.hostHome, launchAgentsDir: opts.launchAgentsDir });
    if (!opts.launchAgentsDir) {
      const domain = `gui/${process.getuid?.() ?? 501}`;
      try { execFileSync("/bin/launchctl", ["bootout", `${domain}/${HOST_LABEL}`], { stdio: "ignore" }); } catch {}
      execFileSync("/bin/launchctl", ["bootstrap", domain, plistFile], { stdio: "inherit" });
    }
  }
  return { host_id: got.host_id, secretsFile, plistFile, brains: got.brains };
}

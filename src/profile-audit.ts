import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHomeShared } from "./sandbox.js";

/**
 * What the machine shares between projects that no sandbox rule decides.
 *
 * The sandbox walls files a project's agents may read. This audit looks at the operator's own setup
 * around it — the places where one project's things reach another's CLI without crossing any wall:
 *
 *  - `shared-dir`         a profile's `skills` / `commands` / `agents` / `hooks` / `plugins` is a link
 *                         to another profile's: whatever is added there appears here, unchosen.
 *  - `shared-marketplace` a third-party plugin marketplace is installed in profiles of different
 *                         projects (a client's private plugins cloned into another client's profile).
 *  - `shell-export`       a secret exported at the top level of a shell rc file: every CLI started
 *                         from that shell inherits it, whichever project it belongs to.
 *  - `mixed-store`        one credential file (`~/.aws/credentials`, `~/.aws/config`) holds entries
 *                         named after more than one project.
 *  - `walled-claude-path` the other way round: a project's profile relies on something in the
 *                         operator's own `~/.claude` that its agents cannot read there (sandbox.ts
 *                         claudeHomeWall) — a hook script, an MCP server's launcher, a link. It fails
 *                         inside every sandboxed session, quietly.
 *
 * Read-only, names only: it never returns a value from an rc file or a credential file. It finds;
 * it does not fix — each finding says what to change.
 */
export type AuditCheck = "shared-dir" | "shared-marketplace" | "shell-export" | "mixed-store" | "walled-claude-path";

export interface AuditFinding {
  check: AuditCheck;
  /** The file or directory the finding is about. */
  path: string;
  /** Project slugs it touches (empty when it reaches every CLI, e.g. a shell export). */
  workspaces: string[];
  detail: string;
  fix: string;
}

export interface AuditInput {
  home?: string;
  /** Every profile directory (config.ts `CONFIG.profiles` values). */
  profileDirs: string[];
  /** The projects and the profile each runs on. */
  workspaces: Array<{ slug: string; config_dir: string | null }>;
  /** Marketplaces any profile may carry. Defaults to the official one + `CHRONOS_SHARED_MARKETPLACES`. */
  sharedMarketplaces?: string[];
  /** CHRONOS_CLAUDE_SHARED_EXTRA, as the sandbox reads it (config.ts). */
  claudeShared?: string[];
}

const SHARED_DIRS = ["skills", "commands", "agents", "hooks", "plugins", "output-styles"];
const RC_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile", ".bashrc", ".profile"];
const SECRET_NAME = /API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY/i;
const STORES = [".aws/credentials", ".aws/config"];

const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (child: string, dir: string) => child === dir || child.startsWith(dir + path.sep);

function defaultShared(): string[] {
  return ["claude-plugins-official", ...(process.env.CHRONOS_SHARED_MARKETPLACES ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
}

export function auditProfiles(input: AuditInput): AuditFinding[] {
  const home = input.home ?? os.homedir();
  const defaultDir = path.join(home, ".claude");
  const out: AuditFinding[] = [];

  // Profile dir (resolved) → the projects that run on it. A profile no project runs on (the
  // operator's second login) is still a profile: it owns its dir, with no slugs.
  const owners = new Map<string, string[]>();
  for (const d of input.profileDirs) { const r = real(d); if (r && !owners.has(r)) owners.set(r, []); }
  for (const w of input.workspaces) {
    const r = real(w.config_dir ?? defaultDir);
    if (!r) continue;
    owners.set(r, [...(owners.get(r) ?? []), w.slug]);
  }
  const profiles = [...owners.keys()];
  const sameOwners = (a: string, b: string) => {
    const x = owners.get(a) ?? [], y = owners.get(b) ?? [];
    return x.length === y.length && x.every((s) => y.includes(s));
  };

  // 1. A whole directory linked in from another profile. Only profiles a project runs on are judged:
  //    an unassigned profile mirroring the default one is the operator's own second login.
  for (const dir of profiles) {
    const mine = owners.get(dir) ?? [];
    if (!mine.length) continue;
    for (const name of SHARED_DIRS) {
      const p = path.join(dir, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      const target = real(p);
      if (!target) continue;
      const from = profiles.find((o) => o !== dir && inside(target, o));
      if (!from || sameOwners(dir, from)) continue;
      const theirs = owners.get(from) ?? [];
      out.push({
        check: "shared-dir", path: p, workspaces: [...new Set([...mine, ...theirs])],
        detail: `${name} of ${mine.join(", ")} is a link to ${target}${theirs.length ? ` (${theirs.join(", ")})` : ""}: everything added there shows up here.`,
        fix: `Make ${p} a real directory and link in only the entries this project should have.`,
      });
    }
  }

  // 2. A third-party marketplace in profiles of different projects. Profiles whose plugins dir is
  //    the same directory (a link) count once.
  const shared = new Set(input.sharedMarketplaces ?? defaultShared());
  const byMarket = new Map<string, Map<string, string>>(); // marketplace → plugins dir (resolved) → profile dir
  for (const dir of profiles) {
    const pluginsDir = real(path.join(dir, "plugins"));
    if (!pluginsDir) continue;
    let known: Record<string, unknown>;
    try { known = JSON.parse(fs.readFileSync(path.join(pluginsDir, "known_marketplaces.json"), "utf8")); } catch { continue; }
    for (const m of Object.keys(known ?? {})) {
      if (shared.has(m)) continue;
      if (!byMarket.has(m)) byMarket.set(m, new Map());
      if (!byMarket.get(m)!.has(pluginsDir)) byMarket.get(m)!.set(pluginsDir, dir);
    }
  }
  for (const [m, dirs] of byMarket) {
    const holders = [...dirs.values()];
    if (holders.length < 2 || holders.every((h) => sameOwners(h, holders[0]))) continue;
    out.push({
      check: "shared-marketplace", path: holders.map((h) => path.join(h, "plugins")).join(", "),
      workspaces: [...new Set(holders.flatMap((h) => owners.get(h) ?? []))],
      detail: `Plugin marketplace "${m}" is installed in ${holders.length} profiles of different projects.`,
      fix: `Keep it in the one profile it belongs to (claude plugin marketplace remove ${m} in the others), or list it in CHRONOS_SHARED_MARKETPLACES if every project may have it.`,
    });
  }

  // 3. Secrets exported at the top level of a shell rc file. An indented line is inside a function
  //    or a block — scoped to what calls it — and is not reported.
  for (const rc of RC_FILES) {
    const file = path.join(home, rc);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    text.split("\n").forEach((line, i) => {
      const m = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (!m || !SECRET_NAME.test(m[1])) return;
      out.push({
        check: "shell-export", path: `${file}:${i + 1}`, workspaces: [],
        detail: `${m[1]} is exported to every shell, so every CLI started by hand inherits it.`,
        fix: `Remove the export; give ${m[1]} to the project that owns it (mc vars / its secrets file) or set it inside that project's launcher function.`,
      });
    });
  }

  // 4. One credential file with sections named after more than one project (`[acme]`,
  //    `[profile acme-prod]`). Section names only.
  const slugs = input.workspaces.map((w) => w.slug);
  for (const rel of STORES) {
    const file = path.join(home, rel);
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const found = new Set<string>();
    for (const m of text.matchAll(/^\[(?:profile\s+)?([^\]\s]+)\]/gm)) {
      const s = slugs.find((slug) => m[1] === slug || m[1].startsWith(slug + "-") || m[1].startsWith(slug + "_"));
      if (s) found.add(s);
    }
    if (found.size < 2) continue;
    out.push({
      check: "mixed-store", path: file, workspaces: [...found],
      detail: `Holds credentials of ${[...found].join(" and ")} in one file: whoever may read it for one reads the other's.`,
      fix: `One file per project, named by AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE in that project's env; keep ${rel} out of every sandbox_allow.`,
    });
  }

  // 5. A project's profile (not the default one) pointing into ~/.claude at something the sandbox hides
  //    from it: a path in its settings / .claude.json (a hook, an MCP server's command or args), or a
  //    link at its top level or one level into its shared dirs. The path and where it is named, never
  //    the value around it.
  const claudeDir = real(defaultDir);
  if (claudeDir) {
    const homes = [...new Set([home, real(home) ?? home])].map(escapeRe).join("|");
    const ref = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|${homes})/\\.claude/([^\\s"'\`:;,)]+)`, "g");
    for (const dir of profiles) {
      const mine = owners.get(dir) ?? [];
      if (dir === claudeDir || !mine.length) continue;
      const found = new Map<string, string>(); // path inside ~/.claude → where the profile names it
      const note = (rel: string, where: string) => {
        if (rel.startsWith("..") || found.has(rel) || claudeHomeShared(rel, input.claudeShared, home)) return;
        found.set(rel, where);
      };
      for (const f of ["settings.json", "settings.local.json", ".claude.json"]) {
        let cfg: unknown;
        try { cfg = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
        walkStrings(cfg, [], (keys, s) => { for (const m of s.matchAll(ref)) note(path.normalize(m[1]), `${f} → ${keys.join(".")}`); });
      }
      for (const sub of ["", ...SHARED_DIRS]) {
        let names: string[];
        try { names = fs.readdirSync(path.join(dir, sub)); } catch { continue; }
        for (const n of names) {
          const p = path.join(dir, sub, n);
          try { if (!fs.lstatSync(p).isSymbolicLink()) continue; } catch { continue; }
          const target = real(p);
          if (target && inside(target, claudeDir) && target !== claudeDir) note(path.relative(claudeDir, target), `the link ${path.join(sub, n)}`);
        }
      }
      for (const [rel, where] of found) {
        out.push({
          check: "walled-claude-path", path: path.join(defaultDir, rel), workspaces: mine,
          detail: `${where} in ${dir} uses ~/.claude/${rel}, which agents on this profile cannot read: it fails in every sandboxed session.`,
          fix: `If ${mine.join(", ")} may read it, add ${rel.split(path.sep)[0]} to CHRONOS_CLAUDE_SHARED_EXTRA (read-only, never writable); otherwise give ${dir} its own copy.`,
        });
      }
    }
  }

  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every string in a parsed JSON value, with the keys that lead to it (array items as `[]`). */
function walkStrings(v: unknown, keys: string[], on: (keys: string[], s: string) => void): void {
  if (typeof v === "string") on(keys, v);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, [...keys, "[]"], on);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkStrings(x, [...keys, k], on);
}

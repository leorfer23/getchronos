/**
 * Evidence gates + risk tiers.
 *
 * A gate is a shell command a repo must pass before its build is allowed to reach review —
 * typecheck, lint, unit tests, build, whatever that repo's language and toolchain call for. Every
 * repo declares its own list (`repos.gate_cmds`), so a Go service, a dbt project and a Flutter app
 * each gate on their own commands; nothing here assumes a stack.
 *
 * The gate exists because an AI QA verdict on a diff is an opinion. A green gate is a fact, and it
 * is the fact that lets low-risk work merge without the operator reading it. Which work counts as
 * low-risk is decided by `riskFor()` from the paths the build actually touched.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";
import type { Gate, GateResult, Repo, RiskPaths, RiskTier } from "./types.js";

const execFileAsync = promisify(execFile);

const OUTPUT_CAP = 4000; // per gate, tail-kept — enough to name the failure, small enough to prompt with

// ───────────────────────────── declaration ─────────────────────────────

/**
 * A repo's gates, in run order. `gate_cmds` is the modern form; a bare legacy `verify_cmd` is
 * folded in as one gate so repos configured before this existed keep gating unchanged.
 */
export function parseGates(repo?: Repo | null): Gate[] {
  if (!repo) return [];
  const raw = repo.gate_cmds?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((g: any) => ({ name: String(g?.name ?? "gate").trim() || "gate", cmd: String(g?.cmd ?? "").trim() }))
          .filter((g) => g.cmd);
      }
    } catch {
      // fall through to verify_cmd — a malformed JSON blob must not silently disable the gate
    }
  }
  const legacy = repo.verify_cmd?.trim();
  return legacy ? [{ name: "verify", cmd: legacy }] : [];
}

/**
 * Suggested gates for a repo path, by whatever build files are actually there. Used to prefill the
 * repo editor (and answerable to an agent over the API) so attaching a repo doesn't mean the
 * operator hand-remembering each stack's incantations. Suggestions only — nothing runs unconfigured.
 */
export function suggestGates(repoPath: string): Gate[] {
  const has = (f: string) => {
    try { return fs.existsSync(path.join(repoPath, f)); } catch { return false; }
  };
  const readJson = (f: string): any => {
    try { return JSON.parse(fs.readFileSync(path.join(repoPath, f), "utf8")); } catch { return null; }
  };
  const out: Gate[] = [];

  if (has("package.json")) {
    const pkg = readJson("package.json");
    const scripts: Record<string, unknown> = pkg?.scripts ?? {};
    const runner = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm run";
    const script = (n: string) => (runner === "npm run" ? `npm run ${n}` : `${runner} ${n}`);
    if (scripts.typecheck) out.push({ name: "typecheck", cmd: script("typecheck") });
    else if (has("tsconfig.json")) out.push({ name: "typecheck", cmd: "npx tsc --noEmit" });
    if (scripts.lint) out.push({ name: "lint", cmd: script("lint") });
    if (scripts.test) out.push({ name: "test", cmd: runner === "npm run" ? "npm test" : `${runner} test` });
    if (scripts.build) out.push({ name: "build", cmd: script("build") });
  }
  if (has("pyproject.toml") || has("setup.py") || has("requirements.txt")) {
    if (has("ruff.toml") || has(".ruff.toml")) out.push({ name: "lint", cmd: "ruff check ." });
    out.push({ name: "test", cmd: "pytest -q" });
  }
  if (has("go.mod")) {
    out.push({ name: "vet", cmd: "go vet ./..." });
    out.push({ name: "test", cmd: "go test ./..." });
  }
  if (has("Cargo.toml")) {
    out.push({ name: "check", cmd: "cargo check --all-targets" });
    out.push({ name: "test", cmd: "cargo test" });
  }
  if (has("pubspec.yaml")) {
    out.push({ name: "analyze", cmd: "flutter analyze" });
    out.push({ name: "test", cmd: "flutter test" });
  }
  if (has("dbt_project.yml")) out.push({ name: "dbt", cmd: "dbt build --select state:modified+ --defer" });
  if (has("pom.xml")) out.push({ name: "verify", cmd: "mvn -q verify" });
  if (has("build.gradle") || has("build.gradle.kts")) out.push({ name: "test", cmd: "./gradlew test" });
  if (!out.length && has("Makefile")) out.push({ name: "make test", cmd: "make test" });
  return out;
}

// ───────────────────────────── execution ─────────────────────────────

const tail = (s: string) => (s.length > OUTPUT_CAP ? "…(truncated)\n" + s.slice(-OUTPUT_CAP) : s);

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A gate has to run in the same environment as the build it is gating.
 *
 * Gates run through `bash -l` because that is how a gate finds a toolchain only the operator's login
 * profile puts on PATH — flutter, fvm, pyenv, rbenv. But the profile also *prepends* its own
 * versions, and that silently defeats the runtime the daemon was started with: on this machine
 * launchd starts chronosd on fnm's Node 24 and passes that PATH down, while `bash -l` puts
 * Homebrew's Node 26 in front of it. A gate running `npm ci` therefore built better-sqlite3 against
 * a Node the project does not support and failed — while the build agent, which never goes through
 * a login shell, had installed the very same dependencies fine minutes earlier. The gate would have
 * been red for a reason with nothing to do with the change under review, and the builder would have
 * been sent back to fix a failure it could not reproduce.
 *
 * So: source the profile, then put the daemon's PATH back in front of whatever it prepended.
 * Profile-only tools stay reachable; the runtime the build actually used wins the ties.
 */
export function withRuntimePath(cmd: string, env: NodeJS.ProcessEnv): string {
  // pipefail, because a gate's exit code IS its verdict and a shell pipeline reports only the LAST
  // command's status. `flutter test | tail -40` — piping to keep the output readable, the most
  // natural thing in the world to write — is green forever no matter how many tests fail. That is
  // strictly worse than having no gate at all: a green gate is the evidence needsHumanApproval uses
  // to decide it may skip the operator, so a gate that cannot fail hands out permission to ship.
  // Only `pipefail`, deliberately not `set -e`: gates legitimately use `cmd-a || cmd-b` and
  // `setup; check` idioms where the last command's status is exactly what we want.
  const prefix = env.PATH ? `export PATH=${shellQuote(env.PATH)}:"$PATH"; ` : "";
  return `set -o pipefail; ${prefix}${cmd}`;
}

/**
 * Run every gate in `cwd` (the build's isolated worktree), in order, and report each one.
 *
 * Runs all of them even after one fails: the results become the rework instructions handed back to
 * the build agent, and "typecheck AND tests are broken" is a more useful instruction than the first
 * failure alone. Each gate is independently timed out so one hung command can't stall delivery.
 */
/**
 * Where a gate's commands run. Absent = on this machine, in `cwd`, as always. A build whose worktree is
 * on another computer (HOSTS.md phase 5) passes runners that send the same commands there
 * (hosts/workdir.ts gateRunners) — injected rather than imported so this module stays store-free.
 */
export type ShellRunner = (line: string, o: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;
export type CmdRunner = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; timeoutMs: number; maxBuffer: number }) => Promise<{ stdout: string; stderr: string }>;

export async function runGates(
  gates: Gate[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = CONFIG.gateTimeoutSec * 1000,
  shell?: ShellRunner,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const g of gates) {
    const started = Date.now();
    try {
      const { stdout, stderr } = shell
        ? await shell(g.cmd, { env, timeoutMs, maxBuffer: 16 * 1024 * 1024 })
        : await execFileAsync("bash", ["-lc", withRuntimePath(g.cmd, env)], {
            cwd, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
          });
      results.push({ name: g.name, cmd: g.cmd, ok: true, ms: Date.now() - started, output: tail((stdout + stderr).trim()) || null });
    } catch (e: any) {
      const out = String(e?.stdout ?? "") + String(e?.stderr ?? "");
      const why = e?.killed ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit ${e?.code ?? "non-zero"}`;
      results.push({ name: g.name, cmd: g.cmd, ok: false, ms: Date.now() - started, output: tail((out.trim() || String(e?.message ?? e)) + `\n[${why}]`) });
    }
  }
  return results;
}

/**
 * Built-in gate: can this build's branch still land on the default branch?
 *
 * A build that passed every repo gate can still be unshippable, because the gates only ever see the
 * branch in isolation. While the ticket was being worked, main moved — and by review time the branch
 * conflicts. Chronos used to find that out only at merge time, after a human had already approved:
 * the review said "ready", `merge()` opened a PR, and the PR sat there DIRTY with nothing landed
 * (PER-70). Ask the question before the review card exists instead.
 *
 * `git merge-tree --write-tree` does the real 3-way merge in memory — no checkout, no index, nothing
 * touched in the worktree — and exits 1 when it conflicts.
 *
 * Fails OPEN on anything that isn't a detected conflict (no remote, offline fetch, detached HEAD,
 * ancient git). A review must never be withheld because the network was down; the only thing that
 * blocks here is a conflict we actually saw.
 */
export async function mergeGate(
  cwd: string,
  defaultBranch: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = CONFIG.gateTimeoutSec * 1000,
  run?: CmdRunner,
): Promise<GateResult | null> {
  const started = Date.now();
  const git = (args: string[]) =>
    run
      ? run("git", ["-C", cwd, ...args], { env, timeoutMs, maxBuffer: 16 * 1024 * 1024 })
      : execFileAsync("git", ["-C", cwd, ...args], { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  const cmd = `git merge-tree --write-tree HEAD origin/${defaultBranch}`;
  try {
    // Compare against the remote's current tip, not a stale local ref — staleness is the whole bug.
    await git(["fetch", "origin", defaultBranch]);
    await git(["rev-parse", "--verify", `origin/${defaultBranch}`]);
    await git(["merge-tree", "--write-tree", "--name-only", "HEAD", `origin/${defaultBranch}`]);
    return { name: "mergeable", cmd, ok: true, ms: Date.now() - started, output: null };
  } catch (e: any) {
    // exit 1 = conflicts (the one real failure). Anything else = we couldn't ask; don't block on it.
    if (e?.code !== 1) return null;
    const out = String(e?.stdout ?? "");
    // --write-tree --name-only prints: <tree oid>\n<conflicted paths…>\n\n<merge messages>
    const files = out.split("\n").slice(1).join("\n").split("\n\n")[0].trim();
    return {
      name: "mergeable",
      cmd,
      ok: false,
      ms: Date.now() - started,
      output: tail(
        `This branch conflicts with origin/${defaultBranch} and cannot be merged as-is.\n\n` +
          `Conflicting files:\n${files || "(unreported)"}\n\n` +
          `Rebase onto the current default branch and resolve the conflicts:\n` +
          `  git fetch origin && git rebase origin/${defaultBranch}\n` +
          `[exit 1]`,
      ),
    };
  }
}

export const gatesPassed = (results: GateResult[] | null | undefined): boolean =>
  !!results && results.length > 0 && results.every((r) => r.ok);

export function parseGateResults(json: string | null | undefined): GateResult[] | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    return Array.isArray(p) ? (p as GateResult[]) : null;
  } catch {
    return null;
  }
}

/** Markdown summary of a gate run — reused by the reviewer prompt, the rework note, and the UI. */
export function formatGateBlock(results: GateResult[] | null | undefined, opts: { failuresOnly?: boolean } = {}): string {
  if (!results?.length) return "";
  const shown = opts.failuresOnly ? results.filter((r) => !r.ok) : results;
  if (!shown.length) return "";
  const lines = shown.map((r) => {
    const head = `${r.ok ? "✅" : "❌"} **${r.name}** \`${r.cmd}\` (${(r.ms / 1000).toFixed(1)}s)`;
    // Passing gates are evidence by their exit code alone; only failures need their output read.
    return r.ok || !r.output ? head : `${head}\n\`\`\`\n${r.output}\n\`\`\``;
  });
  return lines.join("\n");
}

// ───────────────────────────── risk ─────────────────────────────

/**
 * Default risk globs. Deliberately stack-agnostic and matched against the whole path, because the
 * question isn't "what language is this" but "if this is wrong, does a passing test suite still
 * mean it's safe to ship without a human". Schema changes, credentials, deploy config and money
 * code all answer no.
 */
/** A word that makes a path risky wherever it appears — as a file name or as a directory. */
const anywhere = (...words: string[]) => words.flatMap((w) => [`**/*${w}*`, `**/*${w}*/**`]);

export const RISK_DEFAULTS: Required<Pick<RiskPaths, "high" | "med">> = {
  high: [
    ...anywhere(
      "migration", "flyway", "alembic",
      "auth", "secret", "credential", "password", "token",
      "billing", "payment", "invoice", "payout",
      "terraform", "helm", "k8s", "kubernetes", "launchd", "deploy",
    ),
    "*.sql", "**/*.pem", "**/*.key", "**/.env*", "*.tf", "**/*.tfvars", "*.plist",
    "**/Dockerfile*", "**/docker-compose*", "**/.github/workflows/**",
  ],
  med: [
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "requirements*.txt", "pyproject.toml", "poetry.lock", "Pipfile*",
    "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "Gemfile*", "pom.xml", "build.gradle*",
    "pubspec.yaml", "pubspec.lock",
    "**/config/**", "**/*.config.*", "**/*.graphql", "**/*.proto", "**/*.avsc",
  ],
};

// Escalation by size: a change this broad is beyond what a diff read reliably catches, whatever it touched.
const BIG_FILES = 20;
const BIG_LINES = 800;

export function parseRiskPaths(raw: string | null | undefined): RiskPaths {
  if (!raw?.trim()) return {};
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as RiskPaths) : {};
  } catch {
    return {};
  }
}

/**
 * Minimal glob matcher: `**` spans separators, `*` and `?` don't. A pattern with no `/` is matched
 * against the basename too, so `package.json` catches `ui/package.json`.
 * ponytail: no glob dependency for ~15 lines of regex; swap in picomatch if patterns ever grow braces.
 */
export function globMatch(pattern: string, filePath: string): boolean {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `**/` also matches zero directories, so `**/x` matches a bare `x`.
        if (pattern[i + 1] === "/") { i++; src += "(?:.*/)?"; } else src += ".*";
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  const rx = new RegExp(`^${src}$`, "i");
  if (rx.test(filePath)) return true;
  return !pattern.includes("/") && rx.test(path.basename(filePath));
}

const rank: Record<RiskTier, number> = { low: 0, med: 1, high: 2 };
const higher = (a: RiskTier, b: RiskTier): RiskTier => (rank[a] >= rank[b] ? a : b);

/**
 * Risk tier for a set of changed files. Repo overrides are consulted before the defaults, and the
 * repo's `low` list is consulted first of all — it's the escape hatch for a repo whose layout makes
 * a default pattern wrong (a `docs/deploy/**` that ships nothing).
 */
export function riskFor(files: string[], repo?: Repo | null, changedLines = 0): RiskTier | null {
  // No files is not "nothing risky changed" — it is "we could not see what changed", and the two
  // must never collapse. This used to return a confident `low`, so a build whose diff failed to
  // capture scored as the safest tier there is and `needsHumanApproval`'s "unknown risk is treated
  // as the worst case" rule never fired, because it only triggers on null. Say null and let the
  // caller apply the worst case.
  if (!files.length) return null;
  const over = parseRiskPaths(repo?.risk_paths);
  const useDefaults = over.use_defaults !== false;
  const high = [...(over.high ?? []), ...(useDefaults ? RISK_DEFAULTS.high : [])];
  const med = [...(over.med ?? []), ...(useDefaults ? RISK_DEFAULTS.med : [])];
  const low = over.low ?? [];

  let tier: RiskTier = "low";
  for (const f of files) {
    if (low.some((p) => globMatch(p, f))) continue;
    if (high.some((p) => globMatch(p, f))) return "high"; // nothing outranks it; stop looking
    if (med.some((p) => globMatch(p, f))) tier = higher(tier, "med");
  }
  if (files.length >= BIG_FILES || changedLines >= BIG_LINES) tier = higher(tier, "med");
  return tier;
}

/** Files and changed-line count in a unified diff — the same diff already captured for the review. */
export function diffStats(diff: string | null | undefined): { files: string[]; lines: number } {
  if (!diff) return { files: [], lines: 0 };
  const files = new Set<string>();
  let lines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const p = line.slice(4).trim();
      if (p && p !== "/dev/null") files.add(p.replace(/^[ab]\//, ""));
    } else if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      lines++;
    }
  }
  return { files: [...files], lines };
}

// ───────────────────────────── human gate ─────────────────────────────

export const HUMAN_GATES = ["always", "high", "med", "never"] as const;
export type HumanGate = (typeof HUMAN_GATES)[number];

export function parseHumanGate(v: string | null | undefined): HumanGate {
  return (HUMAN_GATES as readonly string[]).includes(v ?? "") ? (v as HumanGate) : "always";
}

/**
 * Whether an AI reviewer's approve may actually close the ticket, or is only a recommendation.
 *
 * `always`/`never` are the old require_human boolean. The middle tiers are the point of the
 * feature: the operator hands over the routine lane and keeps the tier that would hurt. Handing a
 * lane over is a trade of attention for evidence, so a tiered repo with nothing to show — no gates
 * configured, or a gate that didn't pass — still stops at the human. `never` is the explicit
 * "I don't need the evidence" escape hatch for repos that can't have a gate.
 */
export function needsHumanApproval(
  repo: Repo | null | undefined,
  risk: RiskTier | null,
  gates?: GateResult[] | null,
): boolean {
  const gate = parseHumanGate(repo?.human_gate);
  if (gate === "always") return true;
  if (gate === "never") return false;
  if (!gates?.length || !gatesPassed(gates)) return true;
  // Unknown risk (no diff captured — e.g. an interactive-session ticket) is treated as the worst
  // case: we only skip the operator when we can show why it was safe to.
  const tier: RiskTier = risk ?? "high";
  return rank[tier] >= rank[gate];
}

/** One-line explanation of the gate/risk decision, for the review note and the Telegram card. */
export function riskSummary(risk: RiskTier | null, gates: GateResult[] | null): string {
  const g = gates?.length
    ? gatesPassed(gates)
      ? `gates green (${gates.map((r) => r.name).join(", ")})`
      : `gates FAILING (${gates.filter((r) => !r.ok).map((r) => r.name).join(", ")})`
    : "no gates configured";
  return `risk: ${risk ?? "unknown"} · ${g}`;
}

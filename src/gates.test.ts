import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  diffStats,
  formatGateBlock,
  gatesPassed,
  globMatch,
  mergeGate,
  needsHumanApproval,
  parseGateResults,
  parseGates,
  parseHumanGate,
  riskFor,
  runGates,
  suggestGates,
  withRuntimePath,
} from "./gates.js";
import type { Repo } from "./types.js";

const repo = (over: Partial<Repo> = {}): Repo =>
  ({
    id: "r1", workspace_id: "w1", parent_id: null, name: "repo", path: "/tmp/repo",
    git_remote: null, default_branch: "main", delivery: "pr", done_criteria: null,
    verify_cmd: null, gate_cmds: null, risk_paths: null, human_gate: "always",
    post_merge_cmd: null, ideas_enabled: 1, created_at: "2026-01-01",
    ...over,
  }) as Repo;

// ───────────────────────────── declaration ─────────────────────────────

test("parseGates reads gate_cmds and keeps run order", () => {
  const g = parseGates(repo({ gate_cmds: JSON.stringify([{ name: "typecheck", cmd: "tsc --noEmit" }, { name: "test", cmd: "npm test" }]) }));
  assert.deepEqual(g, [{ name: "typecheck", cmd: "tsc --noEmit" }, { name: "test", cmd: "npm test" }]);
});

test("parseGates folds a legacy verify_cmd in as one gate", () => {
  assert.deepEqual(parseGates(repo({ verify_cmd: "flutter test" })), [{ name: "verify", cmd: "flutter test" }]);
});

test("parseGates falls back to verify_cmd rather than silently disabling a malformed gate_cmds", () => {
  assert.deepEqual(parseGates(repo({ gate_cmds: "{not json", verify_cmd: "go test ./..." })), [{ name: "verify", cmd: "go test ./..." }]);
});

test("parseGates drops entries with no command", () => {
  const g = parseGates(repo({ gate_cmds: JSON.stringify([{ name: "a", cmd: "" }, { name: "b", cmd: "true" }]) }));
  assert.deepEqual(g, [{ name: "b", cmd: "true" }]);
});

test("parseGates on a repo with nothing configured yields no gates", () => {
  assert.deepEqual(parseGates(repo()), []);
  assert.deepEqual(parseGates(null), []);
});

test("suggestGates reads the repo's own build files, not a hardcoded stack", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-"));
  try {
    fs.writeFileSync(path.join(dir, "go.mod"), "module x\n");
    const go = suggestGates(dir).map((g) => g.cmd);
    assert.ok(go.includes("go test ./..."));
    assert.ok(!go.some((c) => c.includes("npm")));

    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }));
    const both = suggestGates(dir).map((g) => g.cmd);
    assert.ok(both.includes("npm test"));
    assert.ok(both.includes("npm run lint"));
    assert.ok(both.includes("go test ./..."), "a polyglot repo keeps both toolchains");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("suggestGates picks the lockfile's package runner", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gates-"));
  try {
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "");
    assert.deepEqual(suggestGates(dir), [{ name: "test", cmd: "pnpm test" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ───────────────────────────── execution ─────────────────────────────

test("runGates reports each gate and keeps going past a failure", async () => {
  const results = await runGates(
    [
      { name: "ok", cmd: "echo hello" },
      { name: "bad", cmd: "echo boom >&2; exit 3" },
      { name: "after", cmd: "echo still-ran" },
    ],
    os.tmpdir(),
    process.env,
  );
  assert.equal(results.length, 3, "a failing gate must not skip the rest — the builder needs the full list");
  assert.equal(results[0].ok, true);
  assert.match(results[0].output ?? "", /hello/);
  assert.equal(results[1].ok, false);
  assert.match(results[1].output ?? "", /boom/);
  assert.equal(results[2].ok, true);
  assert.equal(gatesPassed(results), false);
});

test("gatesPassed is false when no gates ran — absence of evidence is not evidence", () => {
  assert.equal(gatesPassed([]), false);
  assert.equal(gatesPassed(null), false);
  assert.equal(gatesPassed([{ name: "t", cmd: "x", ok: true, ms: 1, output: null }]), true);
});

test("runGates times a hung command out instead of stalling delivery", async () => {
  const results = await runGates([{ name: "hang", cmd: "sleep 30" }], os.tmpdir(), process.env, 300);
  assert.equal(results[0].ok, false);
  assert.match(results[0].output ?? "", /timed out/);
});

test("formatGateBlock shows failure output but not passing noise", () => {
  const block = formatGateBlock([
    { name: "test", cmd: "npm test", ok: true, ms: 1200, output: "600 passing" },
    { name: "lint", cmd: "eslint .", ok: false, ms: 900, output: "3 problems" },
  ]);
  assert.ok(block.includes("✅ **test**"));
  assert.ok(!block.includes("600 passing"));
  assert.ok(block.includes("❌ **lint**"));
  assert.ok(block.includes("3 problems"));

  const only = formatGateBlock(
    [
      { name: "test", cmd: "npm test", ok: true, ms: 1, output: null },
      { name: "lint", cmd: "eslint .", ok: false, ms: 1, output: "bad" },
    ],
    { failuresOnly: true },
  );
  assert.ok(!only.includes("test"));
  assert.ok(only.includes("lint"));
});

test("parseGateResults survives legacy/absent json", () => {
  assert.equal(parseGateResults(null), null);
  assert.equal(parseGateResults("not json"), null);
  assert.equal(parseGateResults('{"not":"an array"}'), null);
  assert.equal(parseGateResults("[]")?.length, 0);
});

// ───────────────────────────── risk ─────────────────────────────

test("globMatch handles ** across separators and bare basenames", () => {
  assert.ok(globMatch("**/migrations/**", "app/db/migrations/001.sql"));
  assert.ok(globMatch("*.sql", "schema.sql"));
  assert.ok(globMatch("package.json", "ui/package.json"), "a bare filename pattern matches at any depth");
  assert.ok(!globMatch("*.sql", "src/app.ts"));
  assert.ok(!globMatch("src/*.ts", "src/deep/app.ts"), "a single star must not cross a separator");
});

test("riskFor: ordinary source is the low lane that gets handed over", () => {
  assert.equal(riskFor(["src/flow.ts", "src/flow.test.ts"], repo()), "low");
});

test("riskFor: schema, secrets, deploy and money paths are high", () => {
  for (const f of [
    "db/migrations/003_add_col.sql",
    "src/auth/session.ts",
    "infra/terraform/main.tf",
    ".github/workflows/deploy.yml",
    "src/billing/invoice.ts",
    "app/.env.production",
  ]) {
    assert.equal(riskFor([f], repo()), "high", `${f} should be high risk`);
  }
});

test("riskFor: dependency manifests are med, and one high file outranks the rest", () => {
  assert.equal(riskFor(["package.json"], repo()), "med");
  assert.equal(riskFor(["README.md", "go.sum"], repo()), "med");
  assert.equal(riskFor(["README.md", "package.json", "db/migrations/1.sql"], repo()), "high");
});

test("riskFor: a very large change is never low, whatever it touched", () => {
  const many = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
  assert.equal(riskFor(many, repo()), "med");
  assert.equal(riskFor(["src/a.ts"], repo(), 900), "med");
});

test("riskFor: repo overrides add patterns, and the low list demotes a wrong default", () => {
  const r = repo({ risk_paths: JSON.stringify({ high: ["src/pricing/**"], low: ["docs/deploy/**"] }) });
  assert.equal(riskFor(["src/pricing/rates.ts"], r), "high");
  assert.equal(riskFor(["docs/deploy/runbook.md"], r), "low", "the low list is the escape hatch for a default that is wrong here");
  assert.equal(riskFor(["db/migrations/1.sql"], r), "high", "defaults still apply alongside overrides");
});

test("riskFor: use_defaults:false drops the built-ins entirely", () => {
  const r = repo({ risk_paths: JSON.stringify({ use_defaults: false, high: ["danger/**"] }) });
  assert.equal(riskFor(["db/migrations/1.sql"], r), "low");
  assert.equal(riskFor(["danger/x.ts"], r), "high");
});

test("diffStats pulls files and changed lines out of a unified diff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "-old",
    "+new",
    "+more",
    "diff --git a/db/migrations/1.sql b/db/migrations/1.sql",
    "--- /dev/null",
    "+++ b/db/migrations/1.sql",
    "+create table t();",
  ].join("\n");
  const { files, lines } = diffStats(diff);
  assert.deepEqual(files.sort(), ["db/migrations/1.sql", "src/a.ts"]);
  assert.equal(lines, 4);
  assert.equal(riskFor(files, repo()), "high");
  assert.deepEqual(diffStats(null), { files: [], lines: 0 });
});

// ───────────────────────────── human gate ─────────────────────────────

test("parseHumanGate defaults to always on anything unrecognised", () => {
  assert.equal(parseHumanGate("high"), "high");
  assert.equal(parseHumanGate(null), "always");
  assert.equal(parseHumanGate("yes-please"), "always");
});

const green = [{ name: "test", cmd: "npm test", ok: true, ms: 1, output: null }];
const red = [{ name: "test", cmd: "npm test", ok: false, ms: 1, output: "boom" }];

test("needsHumanApproval: always/never are the old boolean", () => {
  for (const risk of ["low", "med", "high"] as const) {
    assert.equal(needsHumanApproval(repo({ human_gate: "always" }), risk, green), true);
    assert.equal(needsHumanApproval(repo({ human_gate: "never" }), risk, null), false);
  }
});

test("needsHumanApproval: a tier hands over the lanes below it", () => {
  const r = repo({ human_gate: "high" });
  assert.equal(needsHumanApproval(r, "low", green), false);
  assert.equal(needsHumanApproval(r, "med", green), false);
  assert.equal(needsHumanApproval(r, "high", green), true);

  const strict = repo({ human_gate: "med" });
  assert.equal(needsHumanApproval(strict, "low", green), false);
  assert.equal(needsHumanApproval(strict, "med", green), true);
  assert.equal(needsHumanApproval(strict, "high", green), true);
});

test("needsHumanApproval: a tiered repo with no evidence keeps the human", () => {
  const r = repo({ human_gate: "high" });
  assert.equal(needsHumanApproval(r, "low", null), true, "no gates configured → nothing to hand over on");
  assert.equal(needsHumanApproval(r, "low", []), true);
  assert.equal(needsHumanApproval(r, "low", red), true);
  assert.equal(needsHumanApproval(repo({ human_gate: "never" }), "high", null), false, "'never' is the explicit no-evidence escape hatch");
});

test("needsHumanApproval: unknown risk is treated as high, never waved through", () => {
  assert.equal(needsHumanApproval(repo({ human_gate: "high" }), null, green), true);
  assert.equal(needsHumanApproval(repo({ human_gate: "med" }), null, green), true);
  assert.equal(needsHumanApproval(undefined, "low", green), true, "no repo → no handover");
});

// ───────────────────────────── mergeGate ─────────────────────────────

// Build a throwaway repo with a real "origin" remote so merge-tree has something to merge against.
function gitRepo(): { dir: string; git: (...a: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-mergegate-"));
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "mc-mergegate-up-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git("remote", "add", "origin", upstream);
  fs.writeFileSync(path.join(dir, "f.txt"), "base\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  git("push", "-q", "origin", "main");
  return { dir, git };
}

test("mergeGate: red when the branch conflicts with the moved default branch", async () => {
  const { dir, git } = gitRepo();
  // main moves…
  fs.writeFileSync(path.join(dir, "f.txt"), "theirs\n");
  git("commit", "-qam", "upstream change");
  git("push", "-q", "origin", "main");
  // …while the build branch edits the same line off the old base.
  git("checkout", "-q", "-b", "mc/x", "HEAD~1");
  fs.writeFileSync(path.join(dir, "f.txt"), "ours\n");
  git("commit", "-qam", "build work");

  const g = await mergeGate(dir, "main", process.env);
  assert.ok(g, "a real conflict must produce a gate result, not a skip");
  assert.equal(g!.ok, false);
  assert.equal(g!.name, "mergeable");
  assert.match(g!.output ?? "", /f\.txt/, "names the conflicting file");
  assert.match(g!.output ?? "", /git rebase origin\/main/, "tells the builder how to fix it");
});

test("mergeGate: green when the branch still merges cleanly", async () => {
  const { dir, git } = gitRepo();
  git("checkout", "-q", "-b", "mc/x");
  fs.writeFileSync(path.join(dir, "other.txt"), "ours\n");
  git("add", "-A");
  git("commit", "-qm", "build work");

  const g = await mergeGate(dir, "main", process.env);
  assert.equal(g?.ok, true);
  assert.ok(gatesPassed([g!]), "a green merge gate must not block the review");
});

test("mergeGate: fails open — an unreachable remote skips the gate, never blocks a review", async () => {
  const { dir, git } = gitRepo();
  git("remote", "set-url", "origin", path.join(os.tmpdir(), "mc-mergegate-does-not-exist"));
  assert.equal(await mergeGate(dir, "main", process.env), null);
  // …and a directory that isn't a git repo at all.
  assert.equal(await mergeGate(os.tmpdir(), "main", process.env), null);
});

// ── gate environment ─────────────────────────────────────────────────────────────────────────────

test("withRuntimePath puts the daemon's PATH ahead of whatever the login profile prepends", () => {
  assert.equal(
    withRuntimePath("npm test", { PATH: "/opt/runtime/bin:/usr/bin" }),
    `set -o pipefail; export PATH='/opt/runtime/bin:/usr/bin':"$PATH"; npm test`,
  );
  // No PATH to reassert → no export, but pipefail still applies.
  assert.equal(withRuntimePath("npm test", {}), "set -o pipefail; npm test");
  // A path with a quote in it must not break out of the export.
  assert.ok(withRuntimePath("x", { PATH: "/a'b" }).includes(`export PATH='/a'\\''b':"$PATH";`));
});

// The regression this exists for: gates run through `bash -l`, which sources the operator's profile
// and prepends its own toolchain. Before the fix a gate ran on whatever node the profile pointed at
// instead of the one launchd started the daemon with — on this machine a Node the project cannot
// even build its native deps against — so a gate could be red for a reason unrelated to the diff.
test("runGates resolves tools from the passed PATH, not the login profile's", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-path-"));
  const probe = path.join(dir, "chronos-probe");
  fs.writeFileSync(probe, "#!/bin/sh\necho from-daemon-path\n");
  fs.chmodSync(probe, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // `chronos-probe` exists ONLY in the injected PATH — a login shell alone would never find it.
  const [res] = await runGates([{ name: "probe", cmd: "chronos-probe" }], dir, {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: os.homedir(),
  });
  assert.equal(res.ok, true, `gate failed — the passed PATH did not survive the login shell: ${res.output}`);
  assert.equal(res.output, "from-daemon-path");
});

// Shadowing is the real failure mode: the tool exists in both PATHs and the profile's copy wins.
test("runGates: the passed PATH wins when it shadows a system tool", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-shadow-"));
  const shadow = path.join(dir, "date"); // /bin/date exists everywhere
  fs.writeFileSync(shadow, "#!/bin/sh\necho shadowed\n");
  fs.chmodSync(shadow, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const [res] = await runGates([{ name: "shadow", cmd: "date" }], dir, {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: os.homedir(),
  });
  assert.equal(res.output, "shadowed", "the login profile's PATH beat the daemon's");
});

// An empty file list means "we could not see what changed", never "nothing risky changed". This
// returned a confident `low` until PER-11: a build whose diff failed to capture scored as the safest
// tier there is, so needsHumanApproval's "unknown risk is treated as the worst case" rule — which
// only fires on null — never fired, and the whole risk tier was inert.
test("riskFor: no files is unknown, not low", () => {
  assert.equal(riskFor([], repo()), null);
  assert.equal(riskFor([], repo(), 5000), null, "a line count without files is still unknown");
  assert.equal(riskFor(["src/a.ts"], repo()), "low", "a file we CAN see is still allowed to be low");
});

test("an uncaptured diff stops at the human on every tier", () => {
  const green = [{ name: "test", cmd: "t", ok: true, ms: 1, output: null }];
  for (const gate of ["med", "high"] as const) {
    assert.equal(
      needsHumanApproval(repo({ human_gate: gate }), riskFor([], repo({ human_gate: gate })), green),
      true,
      `human_gate=${gate} shipped a change nobody could see`,
    );
  }
  // `never` is still the explicit "I don't need the evidence" escape hatch.
  assert.equal(needsHumanApproval(repo({ human_gate: "never" }), riskFor([], repo()), green), false);
});

// A gate's exit code IS its verdict, and a shell pipeline reports only the last command's status.
// `flutter test | tail -40` — piping to keep output readable — was green forever however many tests
// failed. Worse than no gate: green gates are the evidence needsHumanApproval uses to skip the
// operator, so a gate that cannot fail hands out permission to ship.
test("runGates: a piped command still fails when the real command fails", async () => {
  const [piped, plain, ok] = await runGates(
    [
      { name: "piped-fail", cmd: "false | tail -1" },
      { name: "plain-fail", cmd: "exit 1" },
      { name: "piped-pass", cmd: "echo hi | tail -1" },
    ],
    os.tmpdir(),
    { PATH: process.env.PATH ?? "", HOME: os.homedir() },
  );
  assert.equal(piped.ok, false, "a pipeline masked the failure — the gate can never go red");
  assert.equal(plain.ok, false);
  assert.equal(ok.ok, true, "pipefail must not break a pipeline that genuinely succeeds");
  assert.equal(ok.output, "hi");
});

// The `cmd-a || cmd-b` and `setup; check` idioms real gates use (the chronos typecheck gate is
// `[ -d node_modules ] || npm ci --silent; npx tsc --noEmit`) must keep meaning what they say —
// which is why this sets pipefail and deliberately not `set -e`.
test("runGates: || and ; idioms still report the last command's status", async () => {
  const [a, b] = await runGates(
    [
      { name: "or-recovers", cmd: "false || echo recovered" },
      { name: "semicolon-last-wins", cmd: "false; echo still-here" },
    ],
    os.tmpdir(),
    { PATH: process.env.PATH ?? "", HOME: os.homedir() },
  );
  assert.equal(a.ok, true, "`||` recovery must not be turned into a failure");
  assert.equal(b.ok, true, "`;` must still report the LAST command, not the first");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { worktreeRootFor } from "../worktree-core.js";
import { brainOnlyPathsIn, brainPathsInProc, buildRemoteProcSpec, expandPathTokens, tokenizePaths, type ProcSpecInput } from "./proc-spec.js";

// HOSTS.md's rule for headless runs (phase 5): the ProcSpec a brain sends a host carries intent, never
// a brain path. The prose a run acts on (goal, context) names brain paths all the time — the ticket
// file, the worktree, the repo — and those are turned into tokens the host expands against its own.

const HOME = "/Users/leo";
const APP = "/Users/leo/Documents/GitHub/app";
const LIB = "/Users/leo/Documents/GitHub/lib";
const CHRONOS = "/Users/leo/chronos";
const WT = `${worktreeRootFor(APP)}/mc-acm-7`;

const input = (over: Partial<ProcSpecInput> = {}): ProcSpecInput => ({
  runId: "run-1",
  workspace: { id: "ws-acme", slug: "acme" },
  backend: "claude-code",
  profile: "claude-acme",
  job: {
    name: "ticket:ACM-7",
    goal: `You are in an ISOLATED git worktree at ${WT}. Do NOT cd into ${APP}. Read the ticket file at ${APP}/.mc/tickets/ACM-7.md. Sibling: ${LIB}.`,
    append_system: `Standing memo: the operator keeps notes in ${HOME}/Notes/acme.md`,
    model: "sonnet", allowed_tools: null, disallowed_tools: null, max_budget_usd: null,
  },
  context: `Triggered by a change in ${APP}/src/index.ts`,
  sessionId: "sess-1",
  resume: null,
  steer: false,
  repo: { id: "r-app", git_remote: "git@github.com:acme/app.git" },
  wsRepos: [
    { id: "r-app", git_remote: "git@github.com:acme/app.git", path: APP },
    { id: "r-lib", git_remote: "git@github.com:acme/lib.git", path: LIB },
    { id: "r-local", git_remote: null, path: "/Users/leo/scratch" },
  ],
  hostCwd: null,
  sandbox: { mode: "guard", allowRaw: [`${HOME}/.config/gcloud`, "/etc/hosts"], egressLocked: false },
  egress: null,
  env: {
    PATH: "/Users/leo/.mc/bin:/usr/bin", HOME, MC_API: "http://localhost:7777/api",
    MC_WORKSPACE_TOKEN: "tok", GCLOUD_DIR: `${HOME}/.config/gcloud`, BRAIN_FILE: "/opt/chronos-data/tickets/acme/x",
    CLAUDE_CONFIG_DIR: `${HOME}/.claude-acme`,
  },
  nice: 5,
  timeoutMs: 3_600_000,
  files: [{ repo_id: "r-app", rel: ".mc/tickets/ACM-7.md", content: `# ACM-7\nsee ${APP}/README.md` }],
  brainHome: HOME,
  brainPaths: [CHRONOS, "/opt/chronos-data", `${HOME}/.claude-acme`],
  wtRootFor: worktreeRootFor,
  ...over,
});

test("a ProcSpec carries no brain path outside its (tokenized) prose", () => {
  const { spec, dropped, brainOnly } = buildRemoteProcSpec(input());
  assert.deepEqual(brainPathsInProc(spec, [HOME, CHRONOS, APP, LIB]), []);
  assert.deepEqual(brainOnly, [], "every path the task prose names is a repo the host can resolve");
  // The host supplies PATH/HOME/MC_API; a value under the brain's home travels as ~/…; a brain-only
  // path outside it (a data dir) is dropped by KEY — the terminals' rule (spawn-spec.ts portableEnv).
  assert.equal(spec.env.PATH, undefined);
  assert.equal(spec.env.HOME, undefined);
  assert.equal(spec.env.MC_API, undefined);
  assert.equal(spec.env.GCLOUD_DIR, "~/.config/gcloud");
  assert.ok(spec.env_home_relative.includes("GCLOUD_DIR"));
  assert.deepEqual(dropped.sort(), ["BRAIN_FILE"]);
  assert.equal(spec.env.MC_WORKSPACE_TOKEN, "tok");
  // Only repos with a remote (the only way a host can find them), and the sandbox allow as ~/….
  assert.deepEqual(spec.repos.map((r) => r.id), ["r-app", "r-lib"]);
  assert.deepEqual(spec.sandbox.allow, ["~/.config/gcloud"]);
  assert.equal(spec.cwd, null, "no pin: the host's checkout of the repo");
  assert.equal(spec.timeout_ms, 3_600_000);
});

test("task prose: repo and worktree paths become tokens the host expands to ITS paths", () => {
  const { spec } = buildRemoteProcSpec(input());
  assert.equal(
    spec.job.goal,
    "You are in an ISOLATED git worktree at {{chronos:wtroot:r-app}}/mc-acm-7. Do NOT cd into {{chronos:repo:r-app}}. " +
      "Read the ticket file at {{chronos:repo:r-app}}/.mc/tickets/ACM-7.md. Sibling: {{chronos:repo:r-lib}}.",
  );
  assert.equal(spec.context, "Triggered by a change in {{chronos:repo:r-app}}/src/index.ts");
  // On a host whose clones live elsewhere, under another user:
  const host = new Map([["r-app", "/Users/a.smith/code/app"], ["r-lib", "/Users/a.smith/code/lib"]]);
  assert.equal(
    expandPathTokens(spec.job.goal, host, worktreeRootFor),
    "You are in an ISOLATED git worktree at /Users/a.smith/code/.chronos-worktrees/app/mc-acm-7. Do NOT cd into /Users/a.smith/code/app. " +
      "Read the ticket file at /Users/a.smith/code/app/.mc/tickets/ACM-7.md. Sibling: /Users/a.smith/code/lib.",
  );
});

test("tokenizing respects path boundaries: /repo does not eat /repo-two", () => {
  const out = tokenizePaths(`${APP} ${APP}-two ${APP}/x ${APP}.`, [{ id: "a", path: APP }], worktreeRootFor);
  assert.equal(out, `{{chronos:repo:a}} ${APP}-two {{chronos:repo:a}}/x {{chronos:repo:a}}.`);
});

test("a goal naming a brain-only file is caught (it is what keeps such a run on the brain)", () => {
  const { brainOnly } = buildRemoteProcSpec(input({
    job: { ...input().job, goal: `Read the ticket at ${CHRONOS}/tickets/acme/ACM-9.md and the screenshot ${HOME}/chronos/attachments/a.png.` },
  }));
  assert.deepEqual(brainOnly.sort(), [`${CHRONOS}/tickets/acme/ACM-9.md`, `${HOME}/chronos/attachments/a.png`].sort());
  assert.deepEqual(brainOnlyPathsIn("mentions ~/Notes and relative/paths only", [HOME]), []);
  // Standing system text is prose about the workspace, not the task: a memo naming a path is not a pin.
  assert.deepEqual(buildRemoteProcSpec(input()).brainOnly, []);
});

test("a host-reported cwd is allowed even when it reads like a brain path (two Macs, one username)", () => {
  const { spec, brainOnly } = buildRemoteProcSpec(input({ hostCwd: WT, job: { ...input().job, goal: `work in ${WT}` } }));
  assert.equal(spec.cwd, WT);
  assert.deepEqual(brainPathsInProc(spec, [HOME, APP]), [], "cwd is the host's own answer, not a leak");
  assert.deepEqual(brainOnly, []);
});

test("the guard catches a brain path smuggled into a non-prose field", () => {
  const { spec } = buildRemoteProcSpec(input());
  const bad = { ...spec, profile: `${HOME}/.claude-acme` };
  assert.deepEqual(brainPathsInProc(bad, [HOME]), [`profile: ${HOME}`]);
  const badFile = { ...spec, files: [{ repo_id: "r-app", rel: `${APP}/.mc/x`, content: "" }] };
  assert.equal(brainPathsInProc(badFile, [APP]).length, 1);
});

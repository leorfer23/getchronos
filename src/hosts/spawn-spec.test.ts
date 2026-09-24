import { test } from "node:test";
import assert from "node:assert/strict";
import { brainPathsIn, buildRemoteSpawnSpec, expandHomeRelative, homeRelative, profileNameFor, type RemoteSpecInput } from "./spawn-spec.js";

// A brain that looks like the operator's: a home, a chronos checkout, a client profile and repos
// under it. Every one of those paths is something a host must never be handed.
const BRAIN_HOME = "/Users/leo";
const CHECKOUT = "/Users/leo/chronos";
const PROFILE = "/Users/leo/.claude-medialab";
const REPO_PATH = "/Users/leo/Documents/GitHub/airflow";
const ELSEWHERE = "/Volumes/data/chronos-state";

const input = (over: Partial<RemoteSpecInput> = {}): RemoteSpecInput => ({
  sessionId: "sess-1",
  workspace: { id: "ws-1", slug: "medialab" },
  backend: "claude-code",
  model: "opus",
  role: "human",
  cliSession: "sess-1",
  resume: false,
  repo: { id: "r1", git_remote: "git@github.com:medialab-ai/airflow.git" },
  wsRepos: [
    { id: "r1", git_remote: "git@github.com:medialab-ai/airflow.git" },
    { id: "r2", git_remote: null }, // no remote → a host cannot find it, so it is not sent
  ],
  worktree: { branch: "mc/ana-12", base: "main" },
  resumeCwd: null,
  profile: "claude-medialab",
  sandbox: { mode: "guard", allowRaw: ["~/.config/gcloud", "/Users/leo/.aws", "/etc/passwd"], egressLocked: false },
  system: "## How to report your work",
  // What childEnv + backend.env + mcEnv + MC_* hand a LOCAL spawn — paths included, on purpose.
  env: {
    PATH: "/Users/leo/.mc/bin:/usr/bin",
    HOME: BRAIN_HOME,
    USER: "leo",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/x/T/",
    LANG: "en_US.UTF-8",
    MC_API: "http://localhost:7777/api",
    MC_WORKSPACE: "ws-1",
    MC_WORKSPACE_TOKEN: "tok",
    MC_SESSION: "sess-1",
    AI_GATEWAY_API_KEY: "gw-key",
    GOOGLE_APPLICATION_CREDENTIALS: "/Users/leo/.config/gcloud/app.json",
    CURSOR_CONFIG_DIR: "/Users/leo/.cursor-medialab",
    EXTRA_PATHS: "/Users/leo/bin:/opt/homebrew/bin",
    STATE_DIR: `${ELSEWHERE}/x`,
    GIT_AUTHOR_NAME: "Leo",
  },
  nice: 5,
  cols: 120,
  rows: 40,
  seed: "Goal: fix the DAG",
  seedEnterMs: 250,
  brainHome: BRAIN_HOME,
  brainPaths: [CHECKOUT, PROFILE, ELSEWHERE],
  ...over,
});

test("a remote spec carries no absolute brain path — anywhere", () => {
  const { spec, dropped } = buildRemoteSpawnSpec(input());
  assert.deepEqual(brainPathsIn(spec, [BRAIN_HOME, CHECKOUT, PROFILE, REPO_PATH, ELSEWHERE]), []);
  // Belt and braces over the helper: the serialized frame itself.
  const wire = JSON.stringify({ ...spec, system: null, seed: null });
  for (const p of [BRAIN_HOME, CHECKOUT, PROFILE, REPO_PATH, ELSEWHERE]) assert.ok(!wire.includes(p), `${p} leaked: ${wire}`);
  assert.deepEqual(dropped, ["STATE_DIR"], "a brain-only path outside home cannot be translated, so it is not sent");
});

test("the host supplies its own base env and MC_API; secrets, workspace and mc identity travel", () => {
  const { spec } = buildRemoteSpawnSpec(input());
  for (const k of ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "MC_API"]) assert.equal(k in spec.env, false, `${k} is the host's`);
  assert.equal(spec.env.MC_WORKSPACE_TOKEN, "tok");
  assert.equal(spec.env.MC_SESSION, "sess-1");
  assert.equal(spec.env.AI_GATEWAY_API_KEY, "gw-key");
  assert.equal(spec.env.GIT_AUTHOR_NAME, "Leo");
  // Home paths become ~/… and are flagged for the host to expand against ITS home.
  assert.equal(spec.env.GOOGLE_APPLICATION_CREDENTIALS, "~/.config/gcloud/app.json");
  assert.equal(spec.env.EXTRA_PATHS, "~/bin:/opt/homebrew/bin");
  assert.deepEqual(spec.env_home_relative.sort(), ["CURSOR_CONFIG_DIR", "EXTRA_PATHS", "GOOGLE_APPLICATION_CREDENTIALS"]);
  const onHost = expandHomeRelative(spec.env, spec.env_home_relative, "/Users/a.smith");
  assert.equal(onHost.GOOGLE_APPLICATION_CREDENTIALS, "/Users/a.smith/.config/gcloud/app.json");
  assert.equal(onHost.EXTRA_PATHS, "/Users/a.smith/bin:/opt/homebrew/bin");
  assert.equal(onHost.MC_SESSION, "sess-1", "unflagged keys are left alone");
});

test("intent, not paths: repo by remote, profile by name, worktree by branch, sandbox allow as ~/", () => {
  const { spec } = buildRemoteSpawnSpec(input());
  assert.equal(spec.kind, "intent");
  assert.deepEqual(spec.repo, { id: "r1", git_remote: "git@github.com:medialab-ai/airflow.git" });
  assert.deepEqual(spec.repos.map((r) => r.id), ["r1"], "a repo with no remote cannot be found on a host");
  assert.deepEqual(spec.worktree, { branch: "mc/ana-12", base: "main" });
  assert.equal(spec.cwd_hint, "worktree");
  assert.equal(spec.profile, "claude-medialab");
  assert.deepEqual(spec.sandbox, { mode: "guard", allow: ["~/.config/gcloud", "~/.aws"], egress_locked: false });
  assert.deepEqual(spec.seed, { text: "Goal: fix the DAG", enter_after_ms: 250 });
  assert.equal(spec.resume_cwd, null, "a fresh spawn names no directory at all");
});

test("resume carries only the cwd the host reported; a fresh one never does", () => {
  const hostPath = "/Users/a.smith/Documents/GitHub/airflow";
  const r = buildRemoteSpawnSpec(input({ resume: true, resumeCwd: hostPath })).spec;
  assert.equal(r.resume_cwd, hostPath);
  assert.equal(r.cwd_hint, "worktree", "the fallback when that directory is gone on the host");
  assert.equal(buildRemoteSpawnSpec(input({ resume: false, resumeCwd: hostPath })).spec.resume_cwd, null);
  // Two Macs with one username share a home path; the host-reported cwd is still allowed through.
  const same = buildRemoteSpawnSpec(input({ resume: true, resumeCwd: `${BRAIN_HOME}/Documents/GitHub/airflow` })).spec;
  assert.deepEqual(brainPathsIn(same, [BRAIN_HOME]), []);
});

test("brainPathsIn finds a leak wherever it hides", () => {
  const { spec } = buildRemoteSpawnSpec(input());
  const bad = { ...spec, env: { ...spec.env, OOPS: `${PROFILE}/settings.json` }, repos: [{ id: "x", git_remote: `file://${REPO_PATH}` }] };
  const hits = brainPathsIn(bad, [BRAIN_HOME, PROFILE, REPO_PATH]);
  assert.ok(hits.some((h) => h.startsWith("env.OOPS")));
  assert.ok(hits.some((h) => h.startsWith("repos[0].git_remote")));
});

test("homeRelative / profileNameFor", () => {
  assert.deepEqual(homeRelative("/Users/leo", "/Users/leo"), { value: "~", changed: true });
  assert.deepEqual(homeRelative("/Users/leonard/x", "/Users/leo"), { value: "/Users/leonard/x", changed: false }, "a sibling home is not ours");
  const profiles = { claude: "/Users/leo/.claude", "claude-acme": "/Users/leo/.claude-acme", work: "/Volumes/w/.claude" };
  assert.equal(profileNameFor("/Users/leo/.claude-acme", profiles, "claude"), "claude-acme");
  assert.equal(profileNameFor("/Volumes/w/.claude/", profiles, "claude"), "work", "matched by dir, trailing slash ignored");
  assert.equal(profileNameFor("/Users/leo/.claude-new", profiles, "claude"), "claude-new", "the discovery convention");
  assert.equal(profileNameFor(null, profiles, "claude"), "claude");
});

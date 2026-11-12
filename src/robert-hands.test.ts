/**
 * What Robert does himself (robert.hands, src/robert-hands.ts): what counts as a look, when a turn is
 * past its budget, where the work goes when it is, and which folders are his to read but not write.
 * The real sandbox is exercised in robert-hands-sandbox.test.ts, a real turn in robert-hands-turn.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// His home dir and the Personal landing dir live under $HOME: keep this file's out of the real one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "robert-hands-home-"));
process.env.HOME = HOME;
// A created Personal seeds the per-project cron jobs, whose timers would keep this process alive.
process.env.CHRONOS_INBOX_CLEANUP = "0";
process.env.CHRONOS_JOB_CHECK = "0";

const H = await import("./robert-hands.js");
const { resolveSetting, settingsView, writeSetting, _resetSettingsCache } = await import("./settings.js");
const { repos, workspaces } = await import("./store.js");
const { robertGateFor } = await import("./robert-scope.js");
const { REPO_ROOT } = await import("./repo-root.js");

const API = "http://localhost:7777/api";
const curl = (pathAndFlags: string) => `curl -s -H "x-mc-admin: $CHRONOS_ADMIN" -H "content-type: application/json" ${pathAndFlags}`;
const bash = (command: string) => ({ name: "Bash", input: { command }, desc: `run ${command.replace(/\s+/g, " ").slice(0, 90)}` });

function ws(slug: string, extra: Record<string, unknown> = {}) {
  return workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 7)}`, name: slug, config_dir: path.join(HOME, `.claude-${slug}-${Math.random().toString(36).slice(2, 7)}`), ...extra } as any);
}
function clearWorkspaces() {
  for (const w of workspaces.list(true)) workspaces.remove(w.id);
}

// ───────────────────────────── the setting ─────────────────────────────

test("robert.hands: answers by default, both levels, on the Settings page with its help", () => {
  _resetSettingsCache();
  const r = resolveSetting("robert.hands", null);
  assert.deepEqual(r, { value: "answers", source: "default" });
  const v = settingsView(null).find((s) => s.key === "robert.hands")!;
  assert.equal(v.group, "Robert");
  assert.equal(v.type, "enum");
  assert.deepEqual(v.options, ["answers", "anything"]);
  assert.match(v.label, /does himself/);
  assert.match(v.help, /runs Chronos .*goes to an agent terminal/);
  assert.equal(settingsView(ws("hands-view").id).find((s) => s.key === "robert.hands")?.level, "both", "per project too");
  assert.throws(() => writeSetting("robert.hands", "sometimes"), /one of answers, anything/);
});

test("a project can let him do anything while the rest stays on answers", () => {
  const a = ws("hands-a"), b = ws("hands-b");
  writeSetting("robert.hands", "anything", a.id);
  try {
    assert.equal(H.robertHands(a.id), "anything");
    assert.equal(H.robertHands(b.id), "answers");
    assert.equal(H.robertHands(null), "answers");
    assert.equal(H.robertBuiltinTools(a.id, "Bash,Read"), null, "anything: the old wiring, no --tools");
    assert.equal(H.robertBuiltinTools(b.id, "Bash,Read"), "Bash,Read");
  } finally {
    writeSetting("robert.hands", null, a.id);
  }
});

test("no Robert credential takes the wall down; putting it up is fine", () => {
  const fleet = { ws: null, role: "rw", lane: "operator", fleet: true } as const;
  const req = (value: unknown) => ({ method: "PUT", route: { path: "/settings" }, get: () => undefined, params: {}, query: {}, body: { key: "robert.hands", value } }) as any;
  assert.match(robertGateFor(req("anything"), fleet) ?? "", /operator-only: robert\.hands/);
  assert.match(robertGateFor(req(null), fleet) ?? "", /operator-only/, "clearing it may inherit anything");
  assert.equal(robertGateFor(req("answers"), fleet), null);
});

// ───────────────────────────── what counts ─────────────────────────────

const chronos = { routes: false, outside: false };
const work = { routes: false, outside: true };

test("running Chronos never counts: the daemon's API and mc, reads and writes, however they are written", () => {
  const k = (c: H.ToolCall) => H.classifyCall(c);
  for (const cmd of [
    curl(`${API}/fleet`),
    curl(`-X POST ${API}/workspaces -d '{"slug":"globex","name":"Globex","config_dir":"/x/.claude-globex"}'`),
    curl(`-X PUT ${API}/settings -d '{"key":"ws.auto_review","value":true,"workspace":"acme"}'`),
    // A body's own ";" and "|" are text, not statements.
    curl(`-X POST ${API}/workspaces/w1/learn -d '{"fact":"deploys on Fridays; never Mondays | ask first"}'`),
    `H="x-mc-admin: $CHRONOS_ADMIN"; curl -s -H "$H" ${API}/agents/rollup | jq '.counts'`,
    `API=${API}; curl -s -H "x-mc-admin: $CHRONOS_ADMIN" "$API/jobs?workspace=acme" | node -e 'process.stdin.pipe(process.stdout)'`,
    curl(`-X POST ${API}/notes -d "{\\"since\\":\\"$(date -v-1d +%F)\\"}"`),
    "~/.mc/bin/mc session send ab12cd34 \"rebase on main\"",
    "mc desk digest && mc worklog acme --limit 5",
    `for id in a1 b2; do ${curl(`-X PATCH ${API}/jobs/$id -d '{"enabled":true}'`)}; done`,
    `cd /repo && mc session list`,
  ]) assert.deepEqual(k(bash(cmd)), chronos, cmd);
  // Opening or dispatching work routes it — read from the whole command, even when the one-line
  // description has clipped the URL away.
  const open = bash(curl(`-X POST ${API}/sessions -d '{"workspace_id":"w","role":"worker","goal":"fix it"}'`));
  assert.ok(!open.desc.includes("/api/sessions"), "the 90-char description has lost the URL");
  assert.equal(k(open).routes, true);
  for (const cmd of ['mc session new --goal "fix the login bug"', 'mc lead new "ship the export"', "mc job run nightly-export",
    curl(`-X POST ${API}/tickets/0123abcd-0000-4000-8000-000000000000/dispatch`),
    `for id in a1 b2; do ${curl(`-X POST ${API}/jobs/$id/run`)}; done`])
    assert.equal(k(bash(cmd)).routes, true, cmd);
});

test("work outside Chronos counts, including work tucked inside a Chronos-looking command", () => {
  const k = (c: H.ToolCall) => H.classifyCall(c);
  for (const c of [
    { name: "Read", input: { file_path: "/repo/README.md" }, desc: "Read /repo/README.md" },
    { name: "Grep", input: { pattern: "recieve" }, desc: "search recieve" },
    { name: "Glob", input: { pattern: "**/*.ts" }, desc: "find **/*.ts" },
    { name: "WebSearch", input: { query: "sqlite backup" }, desc: "WebSearch" },
    { name: "mcp__slack__read_channel", input: {}, desc: "mcp__slack__read_channel" },
    bash("cd /repo && grep -rn recieve ."),
    bash("git -C /repo log --oneline -20"),
    bash("echo checking"), // any other shell command
    bash("curl -s https://api.github.com/repos/acme/web/pulls"),
    bash("curl -s http://localhost:3000/api/users"), // the project's own dev server, not the daemon
    bash(`${curl(`${API}/fleet`)} && grep -rn TODO /repo`),
    bash(`${curl(`${API}/workspaces`)} | jq -r '.[0].repos[0].path' | xargs grep -rn login`),
    bash(curl(`-X POST ${API}/notes -d "$(cat /repo/notes.md)"`)),
    { desc: "run sed -n 1,80p src/login.ts" }, // a fallback engine's delta: no raw block
  ]) assert.deepEqual(k(c), work, JSON.stringify(c).slice(0, 90));
});

// ───────────────────────────── the budget ─────────────────────────────

const read = (n: number) => ({ name: "Read", input: { file_path: `/repo/f${n}.ts` }, desc: `Read /repo/f${n}.ts` });
const look = bash(curl(`${API}/fleet`));

test("four calls outside Chronos pass, the fifth is cut — once", () => {
  const b = new H.TurnBudget("ws");
  assert.equal(b.limit, 4);
  for (let i = 1; i <= 4; i++) assert.equal(b.note(read(i)), "ok", `read ${i}`);
  assert.equal(b.note(read(5)), "trip");
  assert.equal(b.tripped, true);
  assert.equal(b.note(read(6)), "ok", "a tripped budget says it once");
  assert.deepEqual(b.seen, ["Read f1.ts", "Read f2.ts", "Read f3.ts", "Read f4.ts"], "the cut call is not something he looked at");
});

test("an admin turn of thirty Chronos calls never trips, and its outside calls still count", () => {
  const b = new H.TurnBudget("ws");
  for (let i = 0; i < 15; i++) {
    assert.equal(b.note(look), "ok");
    assert.equal(b.note(bash(curl(`-X POST ${API}/workspaces/w1/brief -d '{"fact":"line ${i}"}'`))), "ok");
  }
  assert.equal(b.outside, 0);
  for (let i = 1; i <= 4; i++) assert.equal(b.note(read(i)), "ok");
  assert.equal(b.note(look), "ok", "Chronos between them changes nothing");
  assert.equal(b.note(read(5)), "trip");
});

test("once he opened the terminal himself, the count is off — that is the job", () => {
  const b = new H.TurnBudget("ws");
  b.note(read(1));
  b.note(bash('mc session new --goal "fix the typo"'));
  for (let i = 0; i < 30; i++) assert.equal(b.note(read(i)), "ok");
  assert.equal(b.routed, true);
  assert.equal(b.tripped, false);
});

test("a long path is named by its real file in the brief, not by the clipped description", () => {
  const b = new H.TurnBudget("ws");
  const long = "/Users/operator/clients/acme/" + "nested/".repeat(14) + "README.md";
  b.note({ name: "Read", input: { file_path: long }, desc: `Read ${long.slice(0, 100)}` });
  assert.deepEqual(b.seen, ["Read README.md"]);
});

test("what he wrote while looking is kept for the brief, up to the cut", () => {
  const b = new H.TurnBudget("ws");
  b.hear("The README has ");
  b.hear("a typo on line 12.");
  for (let i = 1; i <= 5; i++) b.note(read(i));
  b.hear(" more after the cut");
  assert.equal(b.heard, "The README has a typo on line 12.");
});

// ───────────────────────────── the walls ─────────────────────────────

test("his read-only dirs: his project's places and the daemon checkout — never another project's, never $HOME", () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-a-"));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "rh-b-"));
  const land = fs.mkdtempSync(path.join(os.tmpdir(), "rh-land-"));
  const a = ws("walls-a", { default_dir: land }), b = ws("walls-b");
  repos.create({ workspace_id: a.id, name: "a", path: dirA } as any);
  repos.create({ workspace_id: b.id, name: "b", path: dirB } as any);
  const mine = H.robertReadonlyDirs(a.id);
  for (const p of [dirA, fs.realpathSync(dirA), land, path.join(path.dirname(dirA), ".chronos-worktrees", path.basename(dirA)), REPO_ROOT])
    assert.ok(mine.includes(p), `missing ${p}`);
  assert.ok(!mine.includes(dirB) && !mine.includes(fs.realpathSync(dirB)), "another project's repo is not his to list at all");
  assert.ok(!mine.includes(HOME) && !mine.includes("/"), "never home or root");
  const fleet = H.robertReadonlyDirs(null);
  for (const p of [dirA, dirB, land, REPO_ROOT, process.cwd()]) assert.ok(fleet.includes(p), `fleet-wide misses ${p}`);
  writeSetting("robert.hands", "anything");
  try {
    assert.deepEqual(H.robertReadonlyDirs(a.id), []);
    assert.deepEqual(H.robertReadonlyDirs(null), []);
  } finally {
    writeSetting("robert.hands", null);
  }
});

test("a place that is $HOME itself (a landing dir set to ~) is left out rather than freezing his profile", () => {
  const w = ws("walls-home", { default_dir: HOME });
  assert.ok(!H.robertReadonlyDirs(w.id).includes(HOME));
});

// ───────────────────────────── where the work goes ─────────────────────────────

type Opened = { workspace_id: string; goal: string; description: string; created_by: string; role: string; backend?: string };
function opener() {
  const calls: Opened[] = [];
  const open = async (o: Opened) => { calls.push(o); return { id: `0a1b2c3d-${calls.length}000-4000-8000-000000000000` }; };
  return { calls, open: open as any };
}
function tripped(scope: string | null, calls: H.ToolCall[], said = "") {
  const b = new H.TurnBudget(scope);
  if (said) b.hear(said);
  for (const c of calls) if (b.note(c) === "trip") break;
  assert.equal(b.tripped, true, "fixture must trip");
  return b;
}

test("a project's Robert: the terminal opens in his project, seeded with the request and what he found; one line back", async () => {
  const w = ws("handoff-own", { default_backend: "claude-code" });
  const { calls, open } = opener();
  const announced: Array<{ text: string; ws: string }> = [];
  const b = tripped(w.id, [1, 2, 3, 4, 5].map(read), "The typo is on line 12.");
  const out = await H.handOff({ words: "fix the typo in README", wsId: w.id, budget: b, open, announce: (s, at) => announced.push({ text: s.text, ws: at }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspace_id, w.id);
  assert.equal(calls[0].goal, "fix the typo in README");
  assert.equal(calls[0].created_by, "robert");
  assert.equal(calls[0].role, "worker");
  assert.equal(calls[0].backend, "claude-code");
  assert.match(calls[0].description, /"fix the typo in README"/);
  assert.match(calls[0].description, /- Read f1\.ts\n- Read f2\.ts/);
  assert.match(calls[0].description, /The typo is on line 12\./);
  assert.equal(out.reply, "That's more than a quick answer — I opened a terminal for it: fix the typo in README · 0a1b2c3d");
  assert.deepEqual(announced, [{ text: "Opened a terminal: “fix the typo in README”", ws: w.id }], "announced before it opens, as the ledger reads it");
  assert.equal(out.session?.ws, w.id);
});

test("read aloud: no id in the line; in Spanish when he spoke Spanish", async () => {
  const w = ws("handoff-voice");
  const { open } = opener();
  const en = await H.handOff({ words: "research the best sqlite backup approach and write it up", wsId: w.id, budget: tripped(w.id, [1, 2, 3, 4, 5].map(read)), open, spoken: true });
  assert.equal(en.reply, "That's more than a quick answer, so I opened a terminal for it: research the best sqlite backup approach and write it up.");
  const es = await H.handOff({ words: "arreglá el typo del README", wsId: w.id, budget: tripped(w.id, [1, 2, 3, 4, 5].map(read)), open });
  assert.equal(es.reply, "Eso es más que una respuesta rápida — te abrí una terminal: arreglá el typo del README · 0a1b2c3d");
});

test("the terminal did not open: he says so, nothing pretends", async () => {
  const w = ws("handoff-fail");
  const out = await H.handOff({
    words: "fix it", wsId: w.id, budget: tripped(w.id, [1, 2, 3, 4, 5].map(read)),
    open: async () => { throw new Error("workspace session cap reached (6/6)"); },
  });
  assert.equal(out.session, null);
  assert.match(out.reply, /didn't open: workspace session cap reached \(6\/6\)/);
});

test("no project at all (a new install): a Personal project is created on first need, in a folder Chronos owns", async () => {
  clearWorkspaces();
  const root = path.join(HOME, "landing");
  const { calls, open } = opener();
  const out = await H.handOff({ words: "research sqlite backups", wsId: null, budget: tripped(null, [1, 2, 3, 4, 5].map(read), "fleet ledger text"), open, landingRoot: root });
  assert.equal(out.how, "created");
  const p = workspaces.list();
  assert.equal(p.length, 1);
  assert.equal(p[0].slug, "personal");
  assert.equal(p[0].name, "Personal");
  assert.equal(p[0].kind, "personal");
  assert.equal(p[0].default_dir, path.join(root, "personal"));
  assert.ok(fs.statSync(path.join(root, "personal")).isDirectory(), "its landing dir exists before the terminal opens there");
  assert.equal(calls[0].workspace_id, p[0].id);
  assert.match(calls[0].description, /- Read f1\.ts/, "steps that touched no project ride along");
  assert.doesNotMatch(calls[0].description, /fleet ledger text/, "the fleet-wide Robert's own text never does: his prompt holds every project");
  // The next piece of work finds it — no second Personal.
  await H.handOff({ words: "and the release notes", wsId: null, budget: tripped(null, [1, 2, 3, 4, 5].map(read)), open, landingRoot: root });
  assert.equal(workspaces.list().length, 1);
  assert.equal(calls[1].workspace_id, p[0].id);
});

test("the fleet-wide Robert: the project his calls went into; two projects or none of his own → he asks", async () => {
  clearWorkspaces();
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reach-a-"));
  const a = ws("reach-a"), b = ws("reach-b");
  repos.create({ workspace_id: a.id, name: "a", path: dirA } as any);
  const { calls, open } = opener();
  const inA = (n: number) => ({ name: "Read", input: { file_path: path.join(dirA, `f${n}.ts`) }, desc: `Read ${path.join(dirA, `f${n}.ts`)}` });
  const one = await H.handOff({ words: "fix the login bug", wsId: null, budget: tripped(null, [1, 2, 3, 4, 5].map(inA)), open });
  assert.equal(one.how, "reached");
  assert.equal(calls[0].workspace_id, a.id);
  // A call naming b through the API, beside a's files: two projects — no guessing.
  const both = [inA(1), bash(curl(`${API}/sessions?workspace=${b.slug}`)), inA(2), inA(3), inA(4), inA(5)];
  const two = await H.handOff({ words: "fix the login bug", wsId: null, budget: tripped(null, both), open });
  assert.equal(two.session, null);
  assert.match(two.reply, /can't tell which project/);
  // Two client projects, nothing reached, none of them his own: ask rather than drop it in a client's.
  const none = await H.handOff({ words: "research sqlite backups", wsId: null, budget: tripped(null, [1, 2, 3, 4, 5].map(read)), open });
  assert.equal(none.session, null);
  assert.equal(calls.length, 1, "nothing else opened");
  assert.equal(workspaces.list().length, 2, "and no Personal created beside clients");
});

test("homeWorkspace: the only project; else his own; else nothing without create", () => {
  clearWorkspaces();
  assert.deepEqual(H.homeWorkspace(), { ws: null, how: "none" }, "nothing is created unless asked");
  const only = ws("home-only");
  assert.equal(H.homeWorkspace().ws?.id, only.id);
  ws("home-client");
  assert.equal(H.homeWorkspace().how, "none");
  const own = ws("home-own", { kind: "personal" });
  assert.equal(H.homeWorkspace({ create: true }).ws?.id, own.id);
});

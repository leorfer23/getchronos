/**
 * A Desk terminal on a credit/usage wall: which frames are walls (and which are an agent talking
 * about one), which rung of the ladder each wall takes, and the orchestration around it — with the
 * pty, the spawner and Robert stubbed through setFailoverOps. The real-pty path is in
 * terminal-failover.pty.test.ts.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { bus, type BusEvent } from "./bus.js";
import { CONFIG } from "./config.js";
import { db, sessions, workspaces } from "./store.js";
import { backendInstalled } from "./backends/index.js";
import type { DeskPrompt } from "./desk-prompt.js";
import type { Session } from "./types.js";
import {
  CONTINUE_TEXT,
  classifyWall,
  decideFailover,
  detectWall,
  failoverOwns,
  fallbackChain,
  onTerminalQuiet,
  originalBrief,
  resetFailoverState,
  setFailoverOps,
  standInSeed,
  wallLine,
  type DecideInput,
} from "./terminal-failover.js";

// ── frames, shaped like Claude Code 2.1.x at 100 cols ──
const COMPOSER = [
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "> ",
  "────────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];
const WORK = [
  "● Understanding: renumber the flyway migrations so V4.51 stops colliding with V4.51_1.",
  "",
  "● Now running the migration tests to confirm the renumbering.",
  "",
  "● Bash(npm test -- migrations)",
  "  ⎿  PASS src/migrations.test.ts (12 tests)",
  "",
];
const frame = (...wall: string[]) => [...WORK, ...wall, "", ...COMPOSER];

const FABLE_WALL = frame("  ⎿  You're out of usage credits. Switch to another model to continue.");
const SESSION_LIMIT = frame(
  "  ⎿  You've hit your limit · resets 3pm (America/Buenos_Aires)",
  "     /upgrade to increase your usage limit.",
);

test("detectWall: Claude's credit walls read as credit (a model swap can answer them)", () => {
  assert.deepEqual(detectWall(FABLE_WALL), {
    kind: "credit",
    line: "You're out of usage credits. Switch to another model to continue.",
  });
  assert.equal(detectWall(frame("  ⎿  You're out of usage credits. /model to switch models."))?.kind, "credit");
  assert.equal(detectWall(frame("  ⎿  You've hit your Sonnet limit · resets Sep 17, 9am"))?.kind, "credit");
  assert.equal(detectWall(frame("  ⎿  Fable 5 requires usage credits."))?.kind, "credit");
  // The mid-session dialog: title in a box, the offer as options, a footer under it.
  const dialog = [
    ...WORK,
    "╭──────────────────────────────────────────────────────────────╮",
    "│ You've reached your Fable limit                              │",
    "│ You've used your included Fable usage for this week.         │",
    "│ ❯ 1. Switch to Opus and continue                             │",
    "│   2. Not now                                                 │",
    "╰──────────────────────────────────────────────────────────────╯",
    "  Enter to confirm · Esc to cancel",
  ];
  assert.deepEqual(detectWall(dialog), { kind: "credit", line: "You've reached your Fable limit" });
});

test("detectWall: account-wide limits read as limit (Claude itself is capped)", () => {
  assert.deepEqual(detectWall(SESSION_LIMIT), { kind: "limit", line: "You've hit your limit · resets 3pm (America/Buenos_Aires)" });
  assert.equal(detectWall(frame("  ⎿  You've hit your session limit · resets 2:20pm (America/Buenos_Aires)"))?.kind, "limit");
  assert.equal(detectWall(frame("  ⎿  You've hit your weekly limit · resets Sep 17, 9am · progress saved"))?.kind, "limit");
  assert.equal(detectWall(frame("  ⎿  Your org is out of usage · contact your admin"))?.kind, "limit");
  assert.equal(
    detectWall(frame(`  ⎿  API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account's rate limit."}}`))?.kind,
    "limit",
  );
  // Another CLI's plain error row, flush left.
  assert.equal(detectWall(["grok> fix the flaky test", "Error: quota exceeded for this account", "> "])?.kind, "limit");
});

test("detectWall: an agent TALKING about limits is never a wall", () => {
  // Prose in its own sentence, and the same words on a wrapped (indented) row of it.
  assert.equal(detectWall(frame("● Result: added handling for \"You've hit your limit\" so the rate limit resets are respected.")), null);
  assert.equal(detectWall(frame("● The CLI prints this line when the quota is gone:", "  You've hit your limit · resets 3pm")), null);
  // The operator's own prompt echo.
  assert.equal(detectWall(frame("> You've hit your limit — what does that mean?")), null);
  // A diff of the very test fixtures this feature ships.
  assert.equal(detectWall(frame("  ⎿  22 +    detectWall(frame(\"  ⎿  You've hit your limit · resets 3pm\"))")), null);
  // Warnings, not walls.
  assert.equal(detectWall(frame("  ⎿  You've used 90% of your session limit · resets 3pm")), null);
  assert.equal(detectWall(frame("  ⎿  You're now using usage credits")), null);
  // Prose mentioning quotas without an error prefix.
  assert.equal(detectWall(frame("Rate limit handling is now covered by tests.")), null);
});

test("detectWall: only the bottom of the CURRENT frame counts — a wall the work has moved past is stale", () => {
  const moved = [
    "  ⎿  You're out of usage credits. Switch to another model to continue.",
    "> /model opus",
    "  ⎿  Set model to opus",
    `> ${CONTINUE_TEXT}`,
    "● Picked it back up: the migration tests pass after the renumbering.",
    "",
    ...COMPOSER,
  ];
  assert.equal(detectWall(moved), null);
  // ...but when the swapped-to model walls too, the NEW wall at the bottom is what is read.
  const again = [...moved.slice(0, 4), "  ⎿  You've hit your limit · resets 3pm", "", ...COMPOSER];
  assert.deepEqual(detectWall(again), { kind: "limit", line: "You've hit your limit · resets 3pm" });
  // A wall far up the frame with lots under it is history, not the current state.
  assert.equal(detectWall(["  ⎿  You've hit your limit · resets 3pm", ...Array(10).fill("  plain output row"), "> "]), null);
});

test("detectWall: a turn still running (retrying a 429) is not a wall", () => {
  assert.equal(
    detectWall([...WORK, "  ⎿  API Error (429 rate_limit_error) · Retrying in 5 seconds… (attempt 2/10)", "✻ Thinking… (esc to interrupt)", ...COMPOSER]),
    null,
  );
  assert.equal(detectWall(null), null);
  assert.equal(detectWall([]), null);
});

test("wallLine / classifyWall agree with manager-fallback's own regexes", () => {
  assert.equal(wallLine("You've hit your limit · resets 3pm"), "You've hit your limit · resets 3pm");
  assert.equal(wallLine("  You've hit your limit"), null); // indented, no system glyph
  assert.equal(wallLine("● You've hit your limit"), null);
  assert.equal(classifyWall("You're out of usage credits. Switch to another model to continue."), "credit");
  assert.equal(classifyWall("You've hit your session limit · resets 2:20pm"), "limit");
});

// ── the ladder ──
const base = (over: Partial<DecideInput> = {}): DecideInput => ({
  wall: "credit",
  backend: "claude-code",
  model: "fable",
  modelTried: false,
  attempts: 0,
  max: 3,
  modelFallback: "opus",
  chain: ["grok", "cursor"],
  tried: ["claude-code"],
  usable: () => true,
  modelFor: (b) => (b === "grok" ? "grok-4.5" : null),
  ...over,
});

test("decideFailover: a credit wall on fable swaps the model in the same terminal, once", () => {
  assert.deepEqual(decideFailover(base()), { step: "model", to: "opus" });
  // An unknown (profile-default) model is not known to be opus — the swap is still worth one try.
  assert.deepEqual(decideFailover(base({ model: null })), { step: "model", to: "opus" });
  // Already tried → next backend.
  assert.deepEqual(decideFailover(base({ modelTried: true })), { step: "backend", to: "grok", model: "grok-4.5" });
});

test("decideFailover: opus walled, a session limit, or the swap disabled → new backend", () => {
  assert.deepEqual(decideFailover(base({ model: "opus" })), { step: "backend", to: "grok", model: "grok-4.5" });
  assert.deepEqual(decideFailover(base({ model: "claude-opus-4-8" })), { step: "backend", to: "grok", model: "grok-4.5" });
  assert.deepEqual(decideFailover(base({ wall: "limit" })), { step: "backend", to: "grok", model: "grok-4.5" });
  assert.deepEqual(decideFailover(base({ modelFallback: "" })), { step: "backend", to: "grok", model: "grok-4.5" });
  // A model swap is a claude thing: a grok terminal on a credit wall goes to the next backend.
  assert.deepEqual(
    decideFailover(base({ backend: "grok", model: "grok-4.5", tried: ["claude-code", "grok"] })),
    { step: "backend", to: "cursor", model: null },
  );
});

test("decideFailover: skips uninstalled and already-run backends, never loops, gives up at the end or the cap", () => {
  assert.deepEqual(
    decideFailover(base({ wall: "limit", usable: (b) => b !== "grok" })),
    { step: "backend", to: "cursor", model: null },
  );
  // `cursor` and `cursor-agent` are one CLI; `claude` is the terminal that walled.
  assert.equal(
    decideFailover(base({ wall: "limit", backend: "cursor", chain: ["cursor-agent", "claude", "grok"], tried: ["claude-code", "grok", "cursor-agent"] })).step,
    "give_up",
  );
  assert.equal(decideFailover(base({ wall: "limit", chain: ["nope", "claude"] })).step, "give_up");
  const cap = decideFailover(base({ attempts: 3 }));
  assert.equal(cap.step, "give_up");
  assert.match((cap as any).why, /cap reached/);
});

test("fallbackChain: workspace fallback first, then the configured chain, deduped", () => {
  assert.deepEqual(fallbackChain(undefined, ["grok", "cursor"]), ["grok", "cursor"]);
  assert.deepEqual(fallbackChain({ fallback_backend: "cursor" }, ["grok", "cursor"]), ["cursor", "grok"]);
  assert.deepEqual(fallbackChain({ fallback_backend: " " }, ["grok"]), ["grok"]);
});

test("standInSeed carries the goal, the brief and the replay, and defangs the quoted wall", () => {
  const seed = standInSeed({
    from: "claude-code", fromModel: "opus", to: "grok",
    wall: { kind: "limit", line: "You've hit your limit · resets 3pm" },
    goal: "renumber the flyway migrations", brief: "Goal: renumber the flyway migrations\n\nStart now.",
    cwd: "/repo/.chronos-worktrees/shop/PER-12", replay: "## Previous attempt (replayed transcript)\n\"say: You're out of usage credits\"",
  });
  assert.match(seed, /previous agent \(claude-code\/opus\) hit its usage limit/);
  assert.match(seed, /Goal: renumber the flyway migrations/);
  assert.match(seed, /\/repo\/\.chronos-worktrees\/shop\/PER-12/);
  assert.match(seed, /Previous attempt/);
  assert.match(seed, /Do not start over/);
  // The stand-in's own echo of this seed must never read as a wall.
  assert.ok(!/You've hit your|You're out of/.test(seed));
  assert.ok(seed.split("\n").every((row) => wallLine(row) === null));
  assert.equal(originalBrief("FOCUS CONTRACT…\n\n--- Your task ---\nGoal: x"), "Goal: x");
  assert.equal(originalBrief(null), null);
});

// ── orchestration, with the daemon's hands stubbed ──
type Fake = { live: boolean; quiet: boolean; last_out: number; last_in: number; started_at: number; frame: string[]; prompt: DeskPrompt | null };
const T0 = Date.parse("2026-09-14T12:00:00.000Z");
let fakes: Map<string, Fake>;
let sent: Array<{ id: string; req: any }>;
let opened: any[];
let killed: Array<{ id: string; reason: string }>;
let wakes: any[];
let notes: string[];
let events: BusEvent[];
let timers: Array<{ ms: number; fn: () => void }>;
let installed: Set<string>;
let openFails: Set<string>;

bus.on("event", (e: BusEvent) => { if (e.topic === "session.failover") events.push(e); });

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
  resetFailoverState();
  fakes = new Map(); sent = []; opened = []; killed = []; wakes = []; notes = []; events = []; timers = [];
  installed = new Set(["grok", "cursor"]);
  openFails = new Set();
  CONFIG.terminalFailover = true;
  CONFIG.terminalFallbackBackends = ["grok", "cursor"];
  CONFIG.terminalFailoverMax = 3;
  CONFIG.terminalFailoverTypingSec = 20;
  CONFIG.agent.modelFallback = "opus";
  CONFIG.agent.fallbackBackend = "grok";
  CONFIG.agent.fallbackModel = "grok-4.5";
  setFailoverOps({
    activity: (id) => { const f = fakes.get(id); return f ? { ...f } : { live: false, quiet: true, last_out: null, last_in: null, started_at: null }; },
    frame: (id) => fakes.get(id)?.frame ?? null,
    prompt: (id) => fakes.get(id)?.prompt ?? null,
    send: (id, req) => { sent.push({ id, req }); return null; },
    open: async (opts) => {
      if (openFails.has(opts.backend!)) throw new Error(`${opts.backend} exploded`);
      opened.push(opts);
      const row = sessions.create({ ...opts, cwd: opts.cwd! });
      fakes.set(row.id, { live: true, quiet: false, last_out: T0, last_in: T0, started_at: T0, frame: [], prompt: null });
      return row;
    },
    kill: (id, reason) => { killed.push({ id, reason }); sessions.end(id, reason); fakes.get(id)!.live = false; },
    feed: () => ["understanding: renumber the migrations", "act: ran npm test -- migrations"],
    installed: (b) => installed.has(b),
    wake: (w) => { wakes.push(w); },
    notify: (text) => { notes.push(text); },
    later: (ms, fn) => { timers.push({ ms, fn }); return setTimeout(() => {}, 0); },
  });
});

function terminal(over: Partial<Session> = {}, fake: Partial<Fake> = {}): Session {
  const ws = workspaces.create({ slug: `fo-${Math.random().toString(36).slice(2, 8)}`, name: "Jelly", config_dir: "/tmp/fo" } as any);
  const s = sessions.create({ workspace_id: ws.id, backend: "claude-code", model: "fable", goal: "renumber the flyway migrations", cwd: "/tmp/fo-repo", ...over } as any);
  sessions.setMeta(s.id, { first_prompt: "Goal: renumber the flyway migrations\n\nStart now." });
  fakes.set(s.id, { live: true, quiet: true, last_out: T0, last_in: T0, started_at: T0, frame: FABLE_WALL, prompt: { kind: "turn", question: "" }, ...fake });
  return sessions.get(s.id)!;
}
const runTimers = () => { const t = timers.splice(0); t.sort((a, b) => a.ms - b.ms).forEach((x) => x.fn()); };

test("credit wall → /model opus, then a separate continue, in the same terminal; the same frame never fires twice", async () => {
  const s = terminal();
  assert.equal(await onTerminalQuiet(s.id, T0 + 10_000), "model");
  runTimers();
  assert.deepEqual(sent.map((x) => x.req), [{ text: "/model opus" }, { text: CONTINUE_TEXT }]);
  assert.equal(events.length, 1);
  assert.equal((events[0] as any).step, "model");
  assert.equal((events[0] as any).to_model, "opus");
  assert.equal(opened.length, 0);
  assert.equal(wakes.length, 0, "a model swap is not worth a Robert turn");
  // Same frame, no new output since we acted → nothing.
  assert.equal(await onTerminalQuiet(s.id, T0 + 20_000), "stale");
  assert.equal(sent.length, 2);
});

test("the Fable dialog's own 'Switch to Opus and continue' is taken instead of typing into the menu", async () => {
  const s = terminal({}, {
    prompt: { kind: "select", question: "You've reached your Fable limit", options: [{ label: "Switch to Opus and continue", offset: 0 }, { label: "Not now", offset: 1 }] },
  });
  assert.equal(await onTerminalQuiet(s.id, T0 + 10_000), "model");
  runTimers();
  assert.deepEqual(sent.map((x) => x.req), [{ keys: ["enter"] }]);
});

test("model swap then opus walls too → a grok stand-in with the goal + replay, old terminal closed with a reason, Robert woken", async () => {
  const s = terminal();
  await onTerminalQuiet(s.id, T0 + 10_000);
  runTimers();
  const f = fakes.get(s.id)!;
  f.last_out = T0 + 15_000; // the swap produced output…
  f.frame = SESSION_LIMIT;  // …and then the next wall
  assert.equal(await onTerminalQuiet(s.id, T0 + 30_000), "backend");

  assert.equal(opened.length, 1);
  const o = opened[0];
  assert.equal(o.backend, "grok");
  assert.equal(o.model, "grok-4.5");
  assert.equal(o.workspace_id, s.workspace_id);
  assert.equal(o.cwd, "/tmp/fo-repo");
  assert.equal(o.goal, "renumber the flyway migrations");
  assert.equal(o.replaces, s.id);
  assert.equal(o.created_by, "failover");
  assert.match(o.title, /^↪ grok · /);
  assert.match(o.seed, /Goal: renumber the flyway migrations/);
  assert.match(o.seed, /BEGIN REPLAYED TRANSCRIPT/);
  assert.match(o.seed, /ran npm test -- migrations/);

  const stand = sessions.list({ status: "live" }).find((x) => x.backend === "grok")!;
  assert.equal(killed.length, 1);
  assert.equal(killed[0].id, s.id);
  assert.match(killed[0].reason, new RegExp(`continued in grok terminal ${stand.id.slice(0, 8)}`));
  assert.match(sessions.get(s.id)!.end_reason!, /usage limit on claude-code\/opus → continued in grok/);

  const ev = events.find((e: any) => e.step === "backend") as any;
  assert.equal(ev.to_session_id, stand.id);
  assert.equal(ev.from_model, "opus");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].topic, "session.failover");
  assert.match(wakes[0].payload.say, /moved the work to a new grok terminal/);
  assert.equal(notes.length, 1);

  // The grok stand-in walls too → cursor. Then cursor walls → give up (cap 3: model, grok, cursor).
  const g = fakes.get(stand.id)!;
  Object.assign(g, { quiet: true, last_out: T0 + 40_000, frame: ["Error: rate limit exceeded — try again later", "> "] });
  assert.equal(await onTerminalQuiet(stand.id, T0 + 60_000), "backend");
  assert.equal(opened[1].backend, "cursor");
  const cur = sessions.list({ status: "live" }).find((x) => x.backend === "cursor")!;
  Object.assign(fakes.get(cur.id)!, { quiet: true, last_out: T0 + 70_000, frame: ["Error: usage limit reached for your plan", "> "] });
  assert.equal(await onTerminalQuiet(cur.id, T0 + 90_000), "give_up");
  assert.equal(opened.length, 2, "never back to claude or grok");
  assert.equal(sessions.get(cur.id)!.status, "live", "a give-up leaves the terminal for a human");
  assert.ok(wakes.some((w) => /give_up$/.test(w.key)));
});

test("a session limit skips the model step; an uninstalled or failing backend is skipped for the next", async () => {
  installed.delete("grok");
  const s = terminal({}, { frame: SESSION_LIMIT });
  assert.equal(await onTerminalQuiet(s.id, T0 + 10_000), "backend");
  assert.equal(sent.length, 0);
  assert.equal(opened[0].backend, "cursor");

  resetFailoverState();
  installed.add("grok");
  openFails.add("grok");
  const t = terminal({}, { frame: SESSION_LIMIT });
  assert.equal(await onTerminalQuiet(t.id, T0 + 10_000), "backend");
  assert.equal(opened.at(-1).backend, "cursor");
});

test("guards: kill switch, operator typing, scratch terminals, no wall, not quiet", async () => {
  const s = terminal();
  CONFIG.terminalFailover = false;
  assert.equal(await onTerminalQuiet(s.id, T0 + 10_000), "off");
  assert.equal(failoverOwns(s.id), false);
  CONFIG.terminalFailover = true;
  assert.equal(failoverOwns(s.id), true);

  // The operator typed 3s ago: his terminal. Look again once the window has passed.
  fakes.get(s.id)!.last_in = T0 + 7_000;
  assert.equal(await onTerminalQuiet(s.id, T0 + 10_000), "typing");
  assert.equal(sent.length, 0);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 17_000 - 1 && timers[0].ms <= 18_000);
  assert.equal(await onTerminalQuiet(s.id, T0 + 40_000), "model");

  const scratch = terminal({ goal: null });
  sessions.setMeta(scratch.id, {}); // no goal, and…
  db.prepare("UPDATE sessions SET first_prompt=NULL WHERE id=?").run(scratch.id);
  assert.equal(await onTerminalQuiet(scratch.id, T0 + 10_000), "not-agent");

  const fine = terminal({}, { frame: frame("● Result: migrations renumbered, tests green.") });
  assert.equal(await onTerminalQuiet(fine.id, T0 + 10_000), "no-wall");

  const busy = terminal({}, { quiet: false });
  assert.equal(await onTerminalQuiet(busy.id, T0 + 10_000), "not-live");
});

test("backendInstalled: registered AND on disk; end_reason survives the pty's own end and clears on revive", () => {
  assert.equal(backendInstalled("mock"), true); // bin = this node
  assert.equal(backendInstalled("no-such-backend"), false);
  const prev = CONFIG.grokBin;
  CONFIG.grokBin = "/nonexistent/grok";
  try { assert.equal(backendInstalled("grok"), false); } finally { CONFIG.grokBin = prev; }

  const s = sessions.create({ backend: "claude-code", cwd: "/tmp" });
  sessions.end(s.id, "out of credits → continued in grok terminal ab12cd34");
  sessions.end(s.id); // onExit, a moment later, with no reason of its own
  assert.equal(sessions.get(s.id)!.end_reason, "out of credits → continued in grok terminal ab12cd34");
  sessions.revive(s.id);
  assert.equal(sessions.get(s.id)!.end_reason, null);
});

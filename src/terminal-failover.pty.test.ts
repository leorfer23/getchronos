/**
 * The whole failover through REAL ptys: a fake `claude` walls on credits, gets `/model opus` and a
 * continue typed into it, walls again on its session limit, and the daemon opens a fake `grok`
 * terminal seeded with the goal — then closes the claude one with a reason.
 *
 * Both CLIs are tiny node scripts written to a tmp dir and pointed at through CHRONOS_CLAUDE_BIN /
 * CHRONOS_GROK_BIN, which config.ts reads at import — so every module is imported dynamically AFTER
 * the env is set. No token is spent and nothing reaches ~/.claude or ~/.grok (tmp config_dir,
 * GROK_HOME). Robert's wake and the Telegram line are stubbed (CLAUDE.md gotcha 2).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronos-failover-"));
const logs = { claude: path.join(tmp, "claude.log"), grok: path.join(tmp, "grok.log") };
const cwd = path.join(tmp, "repo");
fs.mkdirSync(cwd);

const PRELUDE = `#!${process.execPath}
const fs = require("fs");
const w = (s) => process.stdout.write(s.replace(/\\n/g, "\\r\\n"));
const chrome = () => w("\\n" + "─".repeat(60) + "\\n> \\n" + "─".repeat(60) + "\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\n");
if (process.argv.includes("-p")) process.exit(0); // exit digest / title one-shots: answer nothing
`;
const FAKE_CLAUDE = `${PRELUDE}
w("fake claude ready\\n");
let stage = 0;
require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
  fs.appendFileSync(${JSON.stringify(logs.claude)}, l + "\\n");
  if (stage === 0 && /Start now/.test(l)) {
    stage = 1;
    setTimeout(() => { w("● Understanding: renumber the migrations.\\n  ⎿  You're out of usage credits. Switch to another model to continue.\\n"); chrome(); }, 150);
  } else if (/^\\/model /.test(l)) {
    w("  ⎿  Set model to opus\\n");
  } else if (stage === 1 && /Continue where you left off/.test(l)) {
    stage = 2;
    setTimeout(() => { w("  ⎿  You've hit your limit · resets 3pm (America/Buenos_Aires)\\n     /upgrade to increase your usage limit.\\n"); chrome(); }, 150);
  }
});
`;
// Raw mode, like a real TUI: a canonical-mode tty drops input past MAX_CANON (1024 bytes on macOS),
// and a stand-in's seed — goal, brief, replay — is always longer than that.
const FAKE_GROK = `${PRELUDE}
w("fake grok ready\\n> ");
process.stdin.setRawMode(true);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\r")) >= 0) {
    const l = buf.slice(0, i);
    buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(logs.grok)}, l + "\\n");
    w("● On it.\\n> ");
  }
});
`;
for (const [name, body] of [["claude", FAKE_CLAUDE], ["grok", FAKE_GROK]] as const) {
  fs.writeFileSync(path.join(tmp, name), body, { mode: 0o755 });
}
process.env.CHRONOS_CLAUDE_BIN = path.join(tmp, "claude");
process.env.CHRONOS_GROK_BIN = path.join(tmp, "grok");
process.env.GROK_HOME = path.join(tmp, "grok-home");
process.env.CHRONOS_TERM_QUIET_MS = "1000";
process.env.CHRONOS_TERMINAL_FALLBACK_BACKENDS = "grok";

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
async function until(what: string, fn: () => boolean, ms = 25_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for: ${what}\nclaude log:\n${read(logs.claude)}\ngrok log:\n${read(logs.grok)}`);
}

test("a walled claude terminal swaps to opus, then hands its goal to a new grok terminal and closes with a reason", { timeout: 60_000 }, async () => {
  const { CONFIG } = await import("./config.js");
  const { bus } = await import("./bus.js");
  const { sessions, workspaces } = await import("./store.js");
  const { openSession, killSession, isLive } = await import("./terminal.js");
  const fo = await import("./terminal-failover.js");

  CONFIG.agent.modelFallback = "opus";
  const wakes: any[] = [];
  const notes: string[] = [];
  fo.setFailoverOps({ wake: (w) => { wakes.push(w); }, notify: (t) => { notes.push(t); } });
  const steps: any[] = [];
  bus.on("event", (e: any) => { if (e.topic === "session.failover") steps.push(e); });
  fo.startTerminalFailover();

  const ws = workspaces.create({ slug: "failover-pty", name: "Failover", config_dir: path.join(tmp, "profile"), sandbox_mode: "off" } as any);
  const claude = await openSession({
    workspace_id: ws.id, backend: "claude-code", model: "fable", cwd, goal: "renumber the flyway migrations", role: "human",
  });

  try {
    await until("the model swap and its continue were typed into the claude terminal", () =>
      /^\/model opus$/m.test(read(logs.claude)) && /Continue where you left off/.test(read(logs.claude)));
    await until("the claude terminal to be handed off", () => steps.some((s) => s.step === "backend"));
    const hand = steps.find((s) => s.step === "backend");
    assert.deepEqual(steps.map((s) => s.step), ["model", "backend"]);
    assert.equal(hand.session_id, claude.id);
    assert.equal(hand.from_model, "opus");
    assert.equal(hand.to_backend, "grok");

    const stand = sessions.get(hand.to_session_id)!;
    assert.equal(stand.backend, "grok");
    assert.equal(stand.workspace_id, ws.id);
    assert.equal(stand.cwd, cwd);
    assert.equal(stand.goal, "renumber the flyway migrations");
    assert.match(stand.title ?? "", /^↪ grok · /);

    await until("the claude row to end with its reason", () => sessions.get(claude.id)!.status === "ended" && !isLive(claude.id));
    assert.match(sessions.get(claude.id)!.end_reason ?? "", new RegExp(`continued in grok terminal ${stand.id.slice(0, 8)}`));

    await until("the grok stand-in to receive its seed", () => /taking over a Desk terminal/.test(read(logs.grok)));
    const seed = read(logs.grok);
    assert.match(seed, /Goal: renumber the flyway migrations/);
    assert.match(seed, /Do not start over/);
    assert.equal(wakes.length, 1);
    assert.equal(notes.length, 1);
    // /model was typed exactly once — one wall, one swap.
    assert.equal(read(logs.claude).split("\n").filter((l) => l.startsWith("/model")).length, 1);
    killSession(stand.id);
  } finally {
    for (const s of sessions.list({ status: "live" })) killSession(s.id);
    await new Promise((r) => setTimeout(r, 2500)); // let focus tails and pty exits wind down
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

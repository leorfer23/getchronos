#!/usr/bin/env node
// Stand-in for the claude CLI in warm-manager tests: reads stream-json turns on stdin and answers
// each with a result line. CHRONOS_FAKE_FAIL_ONCE=<path> makes the very first turn of the very
// first process answer with an error result (and stay alive) — the shape that drives the manager's
// kill-and-respawn retry, where a dead process used to fail its own replacement's turn.
import fs from "node:fs";
import readline from "node:readline";

const failOnce = process.env.CHRONOS_FAKE_FAIL_ONCE;
// CHRONOS_FAKE_ARGV=<path> dumps the argv this process was spawned with, so a test can assert what
// the manager actually put on the command line rather than what it meant to.
if (process.env.CHRONOS_FAKE_ARGV) {
  fs.writeFileSync(process.env.CHRONOS_FAKE_ARGV, JSON.stringify(process.argv.slice(2)));
}
// CHRONOS_FAKE_ENV=<path> dumps the env keys a test cares about (what the manager put in the env).
if (process.env.CHRONOS_FAKE_ENV) {
  const keys = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "MC_OPERATOR_SLACK_DM"];
  fs.writeFileSync(process.env.CHRONOS_FAKE_ENV, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
}
// CHRONOS_FAKE_WALL_MODEL=<model> answers every turn of a process spawned with that --model with
// Fable's credit-wall error result (and stays alive) — the shape the model fallback must catch.
// CHRONOS_FAKE_SPAWN_LOG=<path> appends one line per spawn with its --model.
const model = process.argv[process.argv.indexOf("--model") + 1];
if (process.env.CHRONOS_FAKE_SPAWN_LOG) fs.appendFileSync(process.env.CHRONOS_FAKE_SPAWN_LOG, `${model}\n`);
const walled = !!process.env.CHRONOS_FAKE_WALL_MODEL && process.env.CHRONOS_FAKE_WALL_MODEL === model;
// CHRONOS_FAKE_STALE_RESUME=1: a process spawned with --resume dies the way the real CLI does on a
// session id it no longer has ("No conversation found…", exit 1) — after reading the turn, so the
// test never races a write into a dead pipe.
const stale = process.env.CHRONOS_FAKE_STALE_RESUME === "1" && process.argv.includes("--resume");
// The session id this process reports: the one it resumed, else a fresh one per process.
const resumed = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : null;
const sessionId = resumed ?? `fake-session-${process.pid}`;
let n = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  if (stale) {
    process.stderr.write(`No conversation found with session ID: ${resumed}\n`);
    process.exit(1);
  }
  n++;
  const i = n;
  let fail = false;
  if (failOnce && !fs.existsSync(failOnce)) {
    fs.writeFileSync(failOnce, "1");
    fail = true;
  }
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify(
        walled
          ? { type: "result", is_error: true, result: "You're out of usage credits. Switch to another model to continue." }
          : fail
          ? { type: "result", is_error: true, result: "fake failure" }
          : { type: "result", is_error: false, result: `ok:${i}`, session_id: sessionId }
      ) + "\n"
    );
  }, line.includes("!slow") ? 1500 : 120); // a turn whose text says !slow takes 1.5s
});

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
// CHRONOS_FAKE_WALL_MODEL=<model> answers every turn of a process spawned with that --model with
// Fable's credit-wall error result (and stays alive) — the shape the model fallback must catch.
// CHRONOS_FAKE_SPAWN_LOG=<path> appends one line per spawn with its --model.
const model = process.argv[process.argv.indexOf("--model") + 1];
if (process.env.CHRONOS_FAKE_SPAWN_LOG) fs.appendFileSync(process.env.CHRONOS_FAKE_SPAWN_LOG, `${model}\n`);
const walled = !!process.env.CHRONOS_FAKE_WALL_MODEL && process.env.CHRONOS_FAKE_WALL_MODEL === model;
let n = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
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
          : { type: "result", is_error: false, result: `ok:${i}`, session_id: "fake-session" }
      ) + "\n"
    );
  }, 120);
});

/**
 * A run-ask end to end through a REAL pty (src/run-asks.ts): a fake `claude` is opened in a `guard`
 * workspace and records what its own process sees — its env, and whether it can read another
 * workspace's folder — and every line typed into it. Then the terminal asks for a command, the
 * operator runs it, and it must run behind exactly that terminal's wall (the same profile — the other
 * workspace's file stays unreadable — the same env, in the directory it asked from), with the result
 * typed back into that pty as one message.
 *
 * Every edge is the real one (liveWall, sendInput, the drop dir) except that the real process runner
 * is opted into here by name — under CHRONOS_TEST nothing runs a command unless a test says so.
 * The CLI is a node script in a tmp dir, pointed at through CHRONOS_CLAUDE_BIN, which config.ts reads
 * at import, so every module is imported after the env is set (as in term-attach.pty.test.ts). The
 * drop dir root is moved under the same tmp dir (CHRONOS_DROPS), through no symlink.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chronos-runask-pty-")));
const logs = { env: path.join(tmp, "env.json"), probe: path.join(tmp, "probe.txt"), lines: path.join(tmp, "lines.log") };
const mine = path.join(tmp, "acme");
const theirs = path.join(tmp, "initech");
fs.mkdirSync(mine);
fs.mkdirSync(theirs);
fs.writeFileSync(path.join(theirs, "secret.txt"), "initech numbers");
process.env.CHRONOS_DROPS = path.join(tmp, "drops");

fs.writeFileSync(path.join(tmp, "claude"), `#!${process.execPath}
const fs = require("fs");
if (process.argv.includes("-p")) process.exit(0); // exit digest / title one-shots: answer nothing
fs.writeFileSync(${JSON.stringify(logs.env)}, JSON.stringify(process.env));
let probe;
try { probe = "read: " + fs.readFileSync(${JSON.stringify(path.join(theirs, "secret.txt"))}, "utf8"); } catch (e) { probe = "denied: " + e.code; }
fs.writeFileSync(${JSON.stringify(logs.probe)}, probe);
process.stdin.setRawMode(true);
process.stdout.write("\\x1b[?2004hfake claude ready\\r\\n> ");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString().replace(/\\x1b\\[20[01]~/g, "");
  let i;
  while ((i = buf.indexOf("\\r")) >= 0) { fs.appendFileSync(${JSON.stringify(logs.lines)}, buf.slice(0, i) + "\\n"); buf = buf.slice(i + 1); }
});
`, { mode: 0o755 });
process.env.CHRONOS_CLAUDE_BIN = path.join(tmp, "claude");

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
async function until(what: string, fn: () => boolean, ms = 25_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${what}\nlines typed:\n${read(logs.lines)}`);
}

const sandboxWorks = (() => {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) return false;
  try { execFileSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("a run-ask runs behind exactly the wall its terminal was spawned behind, and the result is typed back into that pty", { skip: sandboxWorks ? false : "sandbox-exec cannot apply a profile here (not macOS, or a nested sandbox)" }, async () => {
  const { sessions, workspaces, runAsks } = await import("./store.js");
  const { openSession, killSession, liveWall } = await import("./terminal.js");
  const RA = await import("./run-asks.js");
  RA.setRunAskDeps({ run: RA.runCommand }); // the one opt-in: the real process runner
  const A = workspaces.create({ slug: "runask-acme", name: "Acme", config_dir: path.join(tmp, "profile-a"), default_dir: mine, sandbox_mode: "guard" } as any);
  workspaces.create({ slug: "runask-initech", name: "Initech", config_dir: path.join(tmp, "profile-b"), default_dir: theirs } as any);
  const s = await openSession({ workspace_id: A.id, backend: "claude-code", model: "fable", cwd: mine, goal: "send the test email", role: "human", cols: 100, rows: 30 });
  try {
    await until("the fake CLI to start behind its wall", () => !!read(logs.probe) && !!read(logs.env));
    assert.match(read(logs.probe), /^denied: EPERM/, "the terminal itself cannot read the other workspace's folder");

    // What was kept is what the pty got.
    const wall = liveWall(s.id);
    assert.ok(wall, "a local live terminal has its wall");
    assert.ok(wall.profile && wall.profile.includes(theirs), "its SBPL profile, which denies the other workspace");
    assert.equal(wall.cwd, mine);
    const seen = JSON.parse(read(logs.env));
    // TERM is node-pty's own (hosts/local.ts names the pty "xterm-color"): a run is piped, not a tty.
    for (const [k, v] of Object.entries(wall.env)) if (k !== "TERM") assert.equal(seen[k], v, `the pty saw ${k} as kept`);
    assert.ok(Object.keys(wall.env).length > 10, "the whole env, not a handful");
    assert.equal(wall.env.MC_SESSION, s.id);
    assert.ok(Object.isFrozen(wall) && Object.isFrozen(wall.env), "frozen at spawn: nothing widens it later");

    // The terminal asks; the operator runs it.
    const asked = RA.createRunAsk(sessions.get(s.id)!, {
      command: `cat ${theirs}/secret.txt; echo "cat:$?"; echo "session:$MC_SESSION"; pwd`,
      why: "show the operator that the wall holds",
      cwd: mine,
    });
    assert.ok(asked.ok);
    const out = await RA.runRunAsk(asked.ask, { surface: "desk" });
    assert.ok(out.ok, JSON.stringify(out));
    const fin = await out.done;
    assert.equal(fin?.status, "ran");
    const file = read(fin!.output_path!);
    assert.match(file, /Operation not permitted/, "behind the terminal's profile the other workspace stays unreadable");
    assert.doesNotMatch(file, /initech numbers/);
    assert.match(file, /cat:1/);
    assert.match(file, new RegExp(`session:${s.id}`), "the terminal's env");
    assert.ok(file.trimEnd().endsWith(mine), "in the directory it asked from");
    assert.equal(path.dirname(fin!.output_path!), path.join(tmp, "drops", s.id), "its output in the terminal's own drop dir");
    assert.equal(runAsks.get(asked.ask.id)!.status, "ran");

    // One message, typed into that pty.
    await until("the result typed into the terminal", () => read(logs.lines).includes("[chronos run-ask] The operator ran the command you asked for"));
    const line = read(logs.lines).split("\n").find((l) => l.includes("[chronos run-ask]"))!;
    assert.match(line, /exit 0 after/);
    assert.match(line, /Operation not permitted/);
    assert.ok(line.includes(fin!.output_path!));
  } finally {
    RA.setRunAskDeps(null);
    for (const row of sessions.list({ status: "live" })) killSession(row.id);
    await new Promise((r) => setTimeout(r, 2500)); // let focus tails and pty exits wind down
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

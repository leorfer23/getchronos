import type { Job } from "../types.js";
import { claudeBackend } from "./claude.js";
import { jsonLine, type AgentBackend, type OneShotOpts, type SpawnSpec } from "./types.js";

// Scripted backend: spawns `node -e` emitting claude-shaped stream-json, driven by !directives
// embedded in the job goal. Lets tests (and token-free smoke runs) exercise the REAL execute()
// path — spawn, event parsing, watchdog, rate-limit, park, verifier — in milliseconds, the same
// way qm's mock harness drives its orchestrator. One directive per line, anywhere in the goal:
//
//   !sleep: <ms>         wait before emitting the result (watchdog/park tests)
//   !exit: <code>        exit with <code> emitting no result event
//   !no-result           exit 0 without a result event
//   !error: <msg>        result event with is_error + <msg> as the result text
//   !stderr: <msg>       write <msg> to stderr
//   !rate-limit[: <unix>] rate_limit_event (rejected) [+ resetsAt], then exit 1
//   !cost: <usd>         cost reported on the result event (default 0.01)
//   !cache-read: <n>     cache_read_input_tokens on the result usage (default omitted)
//   !cache-write: <n>    cache_creation_input_tokens on the result usage (default omitted)
//   !event: <json>       emit <json> as its own stream-json line
//   !verdict: <json>     (oneShot only) reply with <json> — drives the verifier. FLAT objects only:
//                        parseVerdict's regex has no nested-brace support, so a nested !verdict
//                        reads as unparseable (non-blocking) and a failing-verdict test passes
//                        vacuously.
//
// No directives → init + a successful result event, like a well-behaved one-turn claude run.
const DIRECTIVE_RE = /^!([a-z-]+)(?::[ \t]*(.*))?$/;

export function parseDirectives(text: string): Array<{ name: string; arg: string }> {
  const out: Array<{ name: string; arg: string }> = [];
  for (const line of text.split("\n")) {
    const m = DIRECTIVE_RE.exec(line.trim());
    if (m) out.push({ name: m[1], arg: (m[2] ?? "").trim() });
  }
  return out;
}

// Runs in the CHILD `node -e` process: argv[1] = goal text, argv[2] = session id. Kept
// dependency-free and self-contained — it re-parses directives itself (the parent's parse is only
// for callers that want to introspect a goal).
const RUN_SCRIPT = `
const text = process.argv[1] || "";
const sessionId = process.argv[2] || "mock-session";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const ds = [];
for (const line of text.split("\\n")) {
  const m = /^!([a-z-]+)(?::[ \\t]*(.*))?$/.exec(line.trim());
  if (m) ds.push({ name: m[1], arg: (m[2] || "").trim() });
}
const get = (n) => ds.find((d) => d.name === n);
const main = async () => {
  out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
  for (const d of ds)
    if (d.name === "event") {
      try {
        out(JSON.parse(d.arg));
      } catch {
        process.stderr.write("mock: bad !event JSON: " + d.arg + "\\n");
      }
    }
  for (const d of ds) if (d.name === "stderr") process.stderr.write(d.arg + "\\n");
  const sleep = get("sleep");
  if (sleep) await new Promise((r) => setTimeout(r, Number(sleep.arg) || 0));
  const rl = get("rate-limit");
  if (rl) {
    const resetsAt = rl.arg ? Number(rl.arg) : null;
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", ...(resetsAt ? { resetsAt } : {}) } });
    process.exitCode = 1;
    return;
  }
  const exit = get("exit");
  if (exit) {
    process.exitCode = Number(exit.arg) || 0;
    return;
  }
  if (get("no-result")) return;
  const err = get("error");
  const costArg = Number(get("cost")?.arg);
  const cost = Number.isFinite(costArg) ? costArg : 0.01;
  const usage = { input_tokens: 100, output_tokens: 50 };
  const cr = Number(get("cache-read")?.arg);
  const cw = Number(get("cache-write")?.arg);
  if (Number.isFinite(cr)) usage.cache_read_input_tokens = cr;
  if (Number.isFinite(cw)) usage.cache_creation_input_tokens = cw;
  out({
    type: "result",
    subtype: err ? "error" : "success",
    is_error: !!err,
    result: err ? err.arg : "mock: " + (text.split("\\n").find((l) => l.trim() && !l.trim().startsWith("!")) || "done").trim(),
    num_turns: 1,
    total_cost_usd: cost,
    usage,
    session_id: sessionId,
  });
};
main();
`;

// oneShot child: argv[1] = prompt. The verifier embeds the job goal inside its prompt, so a
// !verdict directive placed in a job's goal flows through to the judge — end-to-end verifier tests
// without a model. No directive → a passing verdict.
const ONESHOT_SCRIPT = `
const text = process.argv[1] || "";
let reply = '{"met": true, "reason": "mock verifier ok"}';
for (const line of text.split("\\n")) {
  const m = /^!verdict(?::[ \\t]*(.*))?$/.exec(line.trim());
  if (m) reply = (m[1] || "").trim();
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: 0 }) + "\\n");
`;

// Steer-mode child: mirrors claude's --input-format stream-json contract (verified empirically) —
// user messages arrive as JSON lines on stdin, the FIRST one carries the goal (directives apply),
// each message gets its own result event, later messages are echoed as steer_echo events, and the
// process exits when stdin closes. Messages process sequentially through a promise chain so a
// !sleep in the goal delays the steer echo the same way a busy claude turn would.
const STEER_SCRIPT = `
const readline = require("node:readline");
const sessionId = process.argv[1] || "mock-session";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd() });
let first = true;
let chain = Promise.resolve();
// claude reports CUMULATIVE usage on every result event (not per-turn), and the runner relies on
// that via RunResult.usage_cumulative — so the mock must report the same way or tests would encode
// semantics the real CLI doesn't have.
let turns = 0;
const rl = readline.createInterface({ input: process.stdin });
// The contract the runner relies on: the CLI exits when stdin closes, once the messages it already
// received have been answered. Without this the child waits on a closed pipe forever and keeps the
// parent's event loop alive.
rl.on("close", () => { chain.then(() => process.exit(0)); });
rl.on("line", (line) => {
  let text = "";
  try {
    const m = JSON.parse(line);
    text = (m.message?.content ?? []).map((b) => b.text || "").join("");
  } catch {
    return;
  }
  const isFirst = first;
  first = false;
  chain = chain.then(async () => {
    const ds = [];
    for (const l of text.split("\\n")) {
      const m = /^!([a-z-]+)(?::[ \\t]*(.*))?$/.exec(l.trim());
      if (m) ds.push({ name: m[1], arg: (m[2] || "").trim() });
    }
    const get = (n) => ds.find((d) => d.name === n);
    if (!isFirst) out({ type: "steer_echo", text });
    const sleep = get("sleep");
    if (sleep) await new Promise((r) => setTimeout(r, Number(sleep.arg) || 0));
    const err = get("error");
    turns++;
    out({
      type: "result",
      subtype: err ? "error" : "success",
      is_error: !!err,
      result: err ? err.arg : "mock: " + (isFirst ? "turn done" : "steered turn done"),
      num_turns: turns,
      total_cost_usd: 0.01 * turns,
      usage: { input_tokens: 100 * turns, output_tokens: 50 * turns },
      session_id: sessionId,
    });
  });
});
`;

export const mockBackend: AgentBackend = {
  name: "mock",
  supportsResume: true,
  appendsSystem: true,
  bin: () => process.execPath,

  buildArgs(job: Job, sessionId: string, context: string | null, resumeSessionId?: string | null): string[] {
    // A resume really continues the old session id (mirrors claude --resume) — otherwise a future
    // "answered ask resumes through the mock" test would pass vacuously against a fresh session.
    const goal = context ? `${job.goal}\n${context}` : job.goal;
    return ["-e", RUN_SCRIPT, goal, resumeSessionId ?? sessionId];
  },

  oneShot({ prompt }: OneShotOpts): SpawnSpec {
    return { cmd: process.execPath, args: ["-e", ONESHOT_SCRIPT, prompt], env: {} };
  },

  steerArgs(_job: Job, sessionId: string, _resumeSessionId?: string | null): string[] {
    return ["-e", STEER_SCRIPT, sessionId];
  },

  encodeSteer(text: string): string {
    return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
  },

  env() {
    return {};
  },

  parseLine: jsonLine,
  extractResult: (ev) => claudeBackend.extractResult(ev),
  detectRateLimit: (ev) => claudeBackend.detectRateLimit(ev),
};

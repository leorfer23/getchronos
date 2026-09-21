import { test } from "node:test";
import { parseVerdict } from "./merge-gate.js";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeBackend } from "./backends/claude.js";
import { cursorBackend } from "./backends/cursor.js";
import { codexBackend } from "./backends/codex.js";
import { grokBackend } from "./backends/grok.js";
import { opencodeBackend } from "./backends/opencode.js";
import { openaiApiBackend } from "./backends/openai-api.js";
import { listBackends } from "./backends/index.js";
import { addUsage } from "./runner.js";

test("claude oneShot: verifier-style verdict run (tools + budget guardrails)", () => {
  const s = claudeBackend.oneShot({ prompt: "judge this", model: "sonnet", configDir: "/cfg", allowedTools: "Read,Bash", maxBudgetUsd: 0.5 });
  assert.equal(s.cmd, "claude");
  assert.deepEqual(s.args, [
    "-p", "judge this",
    "--output-format", "stream-json", "--verbose",
    "--allowed-tools", "Read,Bash",
    "--strict-mcp-config",
    "--max-budget-usd", "0.5",
    "--dangerously-skip-permissions",
    "--model", "sonnet",
  ]);
  assert.equal(s.env.CLAUDE_CONFIG_DIR, "/cfg");
});

test("claude buildArgs: fresh dispatch uses --session-id; a resume dispatch swaps in --resume with the OLD session id", () => {
  const fresh = claudeBackend.buildArgs({ goal: "g", model: "sonnet" } as any, "new-sess", null);
  assert.ok(fresh.includes("--session-id"));
  assert.equal(fresh[fresh.indexOf("--session-id") + 1], "new-sess");
  assert.ok(!fresh.includes("--resume"));

  const resumed = claudeBackend.buildArgs({ goal: "g", model: "sonnet" } as any, "new-sess", null, "old-sess");
  assert.ok(resumed.includes("--resume"));
  assert.equal(resumed[resumed.indexOf("--resume") + 1], "old-sess");
  assert.ok(!resumed.includes("--session-id"));
});

test("claude oneShot: no guardrail flags when unset", () => {
  const s = claudeBackend.oneShot({ prompt: "hi", model: "haiku", configDir: "/c" });
  assert.ok(!s.args.includes("--allowed-tools"));
  assert.ok(!s.args.includes("--max-budget-usd"));
});

test("claude oneShot: system + resume, null model omits --model", () => {
  const s = claudeBackend.oneShot({ prompt: "hi", system: "SYS", model: null, configDir: "/c", resumeSessionId: "sess-1" });
  assert.ok(s.args.includes("--append-system-prompt"));
  assert.equal(s.args[s.args.indexOf("--append-system-prompt") + 1], "SYS");
  assert.equal(s.args[s.args.indexOf("--resume") + 1], "sess-1");
  assert.ok(!s.args.includes("--model"));
});

test("cursor oneShot: ignores resume/tools/budget, folds system into prompt, sends --model auto explicitly", () => {
  const s = cursorBackend.oneShot({ prompt: "hi", system: "SYS", model: "auto", configDir: "/c", resumeSessionId: "sess-1", allowedTools: "Read,Bash", maxBudgetUsd: 0.5 });
  assert.equal(s.cmd, "cursor-agent");
  assert.ok(!s.args.includes("--resume"));
  // --model is always explicit (never omitted): cursor-agent's CLI has its own persisted default
  // model, independent of "auto" being its catalog default, and omitting the flag inherits that
  // pin instead of the account's auto allowance (see src/backends/cursor.ts).
  assert.deepEqual(s.args.slice(s.args.indexOf("--model"), s.args.indexOf("--model") + 2), ["--model", "auto"]);
  assert.ok(!s.args.includes("--allowed-tools"));
  assert.ok(!s.args.includes("--max-budget-usd"));
  assert.equal(s.args[0], "-p");
  assert.match(s.args[1], /^SYS\n\n---\n\nhi$/);
  assert.deepEqual(s.env, {});
});

// Payload captured from a live cursor-agent run 2026-07-12 (camelCase usage, no cost fields).
test("cursor extractResult: maps live result event (camelCase usage)", () => {
  const ev = cursorBackend.parseLine(JSON.stringify({
    type: "result", subtype: "success", duration_ms: 8034, is_error: false, result: "ok",
    session_id: "a28b759e", request_id: "0953", usage: { inputTokens: 65270, outputTokens: 29, cacheReadTokens: 5920, cacheWriteTokens: 0 },
  }));
  const r = cursorBackend.extractResult(ev)!;
  assert.equal(r.is_error, false);
  assert.equal(r.result_text, "ok");
  assert.equal(r.tokens_in, 65270);
  assert.equal(r.tokens_out, 29);
  assert.equal(r.tokens_cache_read, 5920);
  assert.equal(r.tokens_cache_write, 0);
  assert.equal(r.cost_estimated, true);
  assert.ok(typeof r.cost_usd === "number" && r.cost_usd! > 0, "subscription backends get a labelled estimate");
});

// codex flags verified from docs (untested against live binary):
//   https://developers.openai.com/codex/cli/reference (→ learn.chatgpt.com/docs/developer-commands)
//   JSONL events: https://gist.github.com/alexfazio/359c17d84cb6a5af12bac88fa1db9770
test("codex buildArgs: exec + json + bypass, model only when set", () => {
  const a = codexBackend.buildArgs({ goal: "do it", model: "gpt-5-codex" } as any, "sess", null);
  assert.deepEqual(a, ["exec", "do it", "--json", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5-codex"]);
  const b = codexBackend.buildArgs({ goal: "g" } as any, "sess", "CTX");
  assert.deepEqual(b, ["exec", "g\n\n--- Trigger context (the event that fired this run) ---\nCTX", "--json", "--dangerously-bypass-approvals-and-sandbox"]);
});

test("codex oneShot: folds system, CODEX_HOME, model when set", () => {
  const s = codexBackend.oneShot({ prompt: "hi", system: "SYS", model: "gpt-5", configDir: "/cfg" });
  assert.equal(s.cmd, "codex");
  assert.deepEqual(s.args, ["exec", "SYS\n\n---\n\nhi", "--json", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5"]);
  assert.deepEqual(s.env, { CODEX_HOME: "/cfg" });
});

test("codex oneShot: resume subcommand, null model omits --model", () => {
  const s = codexBackend.oneShot({ prompt: "hi", model: null, configDir: "/c", resumeSessionId: "th-1" });
  assert.deepEqual(s.args, ["exec", "resume", "th-1", "hi", "--json", "--dangerously-bypass-approvals-and-sandbox"]);
});

test("codex extractResult: agent_message carries text; turn.completed carries estimated tokens", () => {
  const ev = codexBackend.parseLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PING" } }));
  assert.deepEqual(codexBackend.extractResult(ev), {
    num_turns: null, cost_usd: null, tokens_in: null, tokens_out: null, is_error: false, summary: "PING", result_text: "PING",
  });
  const turn = codexBackend.extractResult(codexBackend.parseLine(JSON.stringify({
    type: "turn.completed", usage: { input_tokens: 1000, output_tokens: 50 },
  })))!;
  assert.equal(turn.tokens_in, 1000);
  assert.equal(turn.tokens_out, 50);
  assert.equal(turn.cost_estimated, true);
  assert.ok(typeof turn.cost_usd === "number" && turn.cost_usd! > 0);
});

test("openai-api buildArgs throws (one-shot only)", () => {
  assert.throws(() => openaiApiBackend.buildArgs({} as any, "s", null), /one-shot only/);
});

test("listBackends flags headless capability", () => {
  const list = listBackends();
  assert.equal(list.find((b) => b.name === "grok")?.supportsHeadless, true);
  assert.equal(list.find((b) => b.name === "claude-code")?.supportsHeadless, true);
});

test("grok buildArgs: -p + streaming-json + bypass, model/rules only when set", () => {
  const a = grokBackend.buildArgs({ goal: "do it", model: "grok-4.5" } as any, "sess", null);
  assert.deepEqual(a, [
    "-p", "do it", "--output-format", "streaming-json", "--permission-mode", "bypassPermissions",
    "--session-id", "sess", "--model", "grok-4.5",
  ]);
  const b = grokBackend.buildArgs({ goal: "g", append_system: "NOTES" } as any, "sess", "CTX");
  assert.ok(b.includes("--rules") && b[b.indexOf("--rules") + 1] === "NOTES");
  assert.ok(b[1].includes("CTX")); // trigger context folded into goal
  assert.ok(!b.includes("--model")); // no model → omit (no claude-alias fallback)
  assert.deepEqual(b.slice(b.indexOf("--session-id"), b.indexOf("--session-id") + 2), ["--session-id", "sess"]);
});

test("grok extractResult: end carries tokens + labelled estimate, error carries message", () => {
  const end = grokBackend.parseLine(JSON.stringify({ type: "end", stopReason: "EndTurn", num_turns: 2, usage: { input_tokens: 10, output_tokens: 5 } }));
  const r = grokBackend.extractResult(end)!;
  assert.equal(r.num_turns, 2);
  assert.equal(r.tokens_in, 10);
  assert.equal(r.tokens_out, 5);
  assert.equal(r.cost_estimated, true);
  assert.ok(typeof r.cost_usd === "number" && r.cost_usd! > 0);
  assert.equal(r.is_error, false);
  const err = grokBackend.parseLine(JSON.stringify({ type: "error", message: "boom" }));
  assert.equal(grokBackend.extractResult(err)?.is_error, true);
  assert.equal(grokBackend.extractResult(grokBackend.parseLine(JSON.stringify({ type: "text", data: "hi" }))), null);
});

test("claude detectRateLimit: a credit-wall error result is a wall, not a plain failure", () => {
  const line = (o: object) => claudeBackend.parseLine(JSON.stringify(o));
  const wall = "You're out of usage credits. Switch to another model to continue.";
  assert.deepEqual(claudeBackend.detectRateLimit(line({ type: "result", is_error: true, result: wall })), { rateLimited: true, resetsAt: null });
  assert.equal(claudeBackend.detectRateLimit(line({ type: "result", is_error: false, result: "we are out of credits, says the report" })), null);
  assert.equal(claudeBackend.detectRateLimit(line({ type: "result", is_error: true, result: "tool crashed" })), null);
});

test("grok detectRateLimit: matches 429/quota in error events", () => {
  assert.deepEqual(grokBackend.detectRateLimit(grokBackend.parseLine(JSON.stringify({ type: "error", message: "429 too many requests" }))), { rateLimited: true, resetsAt: null });
  assert.equal(grokBackend.detectRateLimit(grokBackend.parseLine(JSON.stringify({ type: "error", message: "bad model" }))), null);
});

test("opencode buildArgs: run + json + auto, folds append_system + context, model when set", () => {
  const a = opencodeBackend.buildArgs({ goal: "do it", model: "vercel/anthropic/claude-sonnet-4.5" } as any, "sess", null);
  assert.deepEqual(a, ["run", "do it", "--format", "json", "--auto", "--model", "vercel/anthropic/claude-sonnet-4.5"]);
  const b = opencodeBackend.buildArgs({ goal: "g", append_system: "NOTES" } as any, "sess", "CTX");
  assert.ok(b[1].startsWith("NOTES") && b[1].includes("CTX")); // system folded before goal, context appended
  assert.ok(!b.includes("--model"));
});

test("opencode extractResult: step_finish carries tokens/cost, error carries message, text ignored", () => {
  const sf = opencodeBackend.parseLine(JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 15, output: 4 }, cost: 0.002 } }));
  assert.deepEqual(opencodeBackend.extractResult(sf), {
    num_turns: null, cost_usd: 0.002, tokens_in: 15, tokens_out: 4, is_error: false, summary: null, result_text: null,
  });
  const err = opencodeBackend.parseLine(JSON.stringify({ type: "error", error: { name: "UnknownError", data: { message: "boom" } } }));
  const r = opencodeBackend.extractResult(err)!;
  assert.equal(r.is_error, true);
  assert.equal(r.result_text, "boom");
  assert.equal(opencodeBackend.extractResult(opencodeBackend.parseLine(JSON.stringify({ type: "text", part: { type: "text", text: "hi" } }))), null);
});

test("opencode: headless-capable, listed once in registry", () => {
  const list = listBackends();
  assert.equal(list.find((b) => b.name === "opencode")?.supportsHeadless, true);
});

test("openai-api oneShot: helper script + positional args, env passthrough", () => {
  const s = openaiApiBackend.oneShot({ prompt: "p", system: "SYS", model: "gpt-4o-mini", configDir: "/c" });
  assert.equal(s.cmd, "node");
  assert.ok(s.args[0].endsWith("scripts/openai-oneshot.mjs"));
  assert.deepEqual(s.args.slice(1), ["gpt-4o-mini", "p", "SYS"]);
  assert.deepEqual(s.env, {}); // keys come from child-env, not the spec
  // null model → empty string, no system arg
  const s2 = openaiApiBackend.oneShot({ prompt: "p", model: null, configDir: "/c" });
  assert.deepEqual(s2.args.slice(1), ["", "p"]);
});

test("openai-oneshot.mjs: POSTs and prints a claude-compatible result line", async () => {
  let seen: any = null;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "42" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const helper = path.resolve(fileURLToPath(import.meta.url), "../../scripts/openai-oneshot.mjs");
  const stdout: string = await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [helper, "test-model", "what is 6*7?", "be terse"],
      { env: { ...process.env, OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` } },
      (err, out) => (err ? reject(err) : resolve(out))
    );
  });
  server.close();
  const line = JSON.parse(stdout.trim().split("\n").pop()!);
  assert.equal(line.type, "result");
  assert.equal(line.result, "42");
  assert.deepEqual(line.usage, { input_tokens: 7, output_tokens: 3 });
  assert.equal(seen.model, "test-model");
  assert.equal(seen.messages[0].role, "system");
  assert.equal(seen.messages[1].content, "what is 6*7?");
});

test("runner accumulates opencode per-step usage into whole totals", () => {
  // opencode emits one step_finish PER step (per-step tokens/cost). extractResult returns each step's
  // numbers; the runner folds them with addUsage. Regression: it used to keep only the last step.
  const steps = [
    { type: "step_finish", part: { type: "step-finish", reason: "tool-calls", tokens: { input: 1000, output: 200 }, cost: 0.03 } },
    { type: "step_finish", part: { type: "step-finish", reason: "tool-calls", tokens: { input: 1500, output: 300 }, cost: 0.05 } },
    { type: "step_finish", part: { type: "step-finish", reason: "stop", tokens: { input: 500, output: 100 }, cost: 0.02 } },
  ];
  let cost: number | null = null, tin: number | null = null, tout: number | null = null;
  for (const s of steps) {
    const r = opencodeBackend.extractResult(opencodeBackend.parseLine(JSON.stringify(s)));
    assert.ok(r);
    cost = addUsage(cost, r!.cost_usd);
    tin = addUsage(tin, r!.tokens_in);
    tout = addUsage(tout, r!.tokens_out);
  }
  assert.equal(Number(cost!.toFixed(2)), 0.10); // 0.03+0.05+0.02, not just last 0.02
  assert.equal(tin, 3000);
  assert.equal(tout, 600);
});

test("addUsage preserves null for a never-reported field (grok cost)", () => {
  // grok reports tokens but never cost. Summing must leave cost null, not 0.
  let cost: number | null = null, tin: number | null = null;
  for (const v of [{ c: null as number | null, t: 100 }, { c: null, t: 250 }]) {
    cost = addUsage(cost, v.c);
    tin = addUsage(tin, v.t);
  }
  assert.equal(cost, null);
  assert.equal(tin, 350);
});

// ── grok: the answer arrives as deltas, not in the terminal event ────────────────────────────────

// grok streams `{type:"text", data:"…"}` chunks and its `end` event carries usage but no text, so
// extractResult legitimately returns summary: null. Nothing merged those chunks, and runs.summary is
// where merge-gate parses APPROVE/HOLD and where the LLM-judge verifier reads its verdict — so all
// 34 of grok's successful runs stored an empty summary and every merge gate it ran left a clean PR
// open with "run finished without a MERGE-GATE verdict line". This is the seam that fixes it.
test("grok.textDelta yields the streamed answer chunks, and nothing else", () => {
  assert.equal(grokBackend.textDelta?.({ type: "text", payload: { data: "MERGE-GATE: " } }), "MERGE-GATE: ");
  assert.equal(grokBackend.textDelta?.({ type: "text", payload: { data: "APPROVE" } }), "APPROVE");
  // Reasoning and tool traffic are not the answer — merging them would corrupt the verdict line.
  assert.equal(grokBackend.textDelta?.({ type: "thought", payload: { data: "hmm" } }), null);
  assert.equal(grokBackend.textDelta?.({ type: "tool_call", payload: { data: "x" } }), null);
  assert.equal(grokBackend.textDelta?.({ type: "end", payload: { usage: {} } }), null);
  // Malformed payloads must not inject "undefined" into the summary.
  assert.equal(grokBackend.textDelta?.({ type: "text", payload: {} }), null);
  assert.equal(grokBackend.textDelta?.({ type: "text", payload: { data: 42 } }), null);
});

test("grok's terminal event still carries usage, and still no text of its own", () => {
  const r = grokBackend.extractResult({ type: "end", payload: { num_turns: 3, usage: { input_tokens: 10, output_tokens: 20 } } });
  assert.equal(r?.is_error, false);
  assert.equal(r?.num_turns, 3);
  assert.equal(r?.tokens_in, 10);
  assert.equal(r?.summary, null, "the summary comes from the deltas — extractResult must not invent one");
});

// The real thing: concatenating the deltas has to produce something parseVerdict accepts. These are
// the actual chunks from merge-gate:PER-13, the run that approved a clean PR and lost the verdict.
test("concatenated grok deltas parse as a merge-gate verdict", () => {
  const chunks = ["### 4. Fixes\nNone needed", " — no push.\n\n---\n\n", "MERGE-GATE:", " APPROVE", " — main clean", "/unmoved; analyze + 38/38 e2e green"];
  const text = chunks.map((data) => grokBackend.textDelta?.({ type: "text", payload: { data } }) ?? "").join("");
  const verdict = parseVerdict(text);
  assert.equal(verdict?.approved, true, "the verdict grok actually emitted must survive reassembly");
  assert.match(verdict!.reason, /main clean/);
});

test("claude interactiveArgs: Desk terminals pass --no-chrome so a spawn never pops a browser window", () => {
  const a = claudeBackend.interactiveArgs!("sonnet", null, [], "sess-1", false);
  assert.ok(a.includes("--no-chrome"));
  assert.ok(a.includes("--dangerously-skip-permissions"));
});

test("cursor interactiveArgs: Desk terminals pass --trust so the workspace-trust prompt never swallows the seed", () => {
  const none = cursorBackend.interactiveArgs!(null);
  assert.ok(none.includes("--trust"));
  // null model still sends an explicit --model auto — see src/backends/cursor.ts.
  assert.deepEqual(none.slice(none.indexOf("--model"), none.indexOf("--model") + 2), ["--model", "auto"]);
  const a = cursorBackend.interactiveArgs!("gpt-5");
  assert.ok(a.includes("--trust"));
  assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2), ["--model", "gpt-5"]);
});

test("cursor interactiveArgs: auto-approves like claude/grok, reaches sibling repos, pins the chat to the session id", () => {
  const a = cursorBackend.interactiveArgs!("auto", "SYS", ["/r/api", "/r/web"], "sess-9", true);
  for (const f of ["--trust", "--force", "--approve-mcps"]) assert.ok(a.includes(f), f);
  // --model is always explicit now: cursor-agent's CLI has its own persisted default model, which
  // silently overrides an omitted flag and can burn paid usage instead of the auto allowance.
  assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2), ["--model", "auto"]);
  assert.deepEqual(a.filter((_, i) => a[i - 1] === "--add-dir"), ["/r/api", "/r/web"]);
  // --resume <id> opens a new chat under that id or reopens it — same flag either way.
  assert.equal(a[a.indexOf("--resume") + 1], "sess-9");
  assert.deepEqual(cursorBackend.interactiveArgs!(null, null, [], "sess-9", false).slice(-2), ["--resume", "sess-9"]);
  assert.ok(!cursorBackend.interactiveArgs!(null).includes("--resume"));
  assert.equal(cursorBackend.pinsSession, true);
  assert.equal(cursorBackend.transcriptPerCwd, true);
});

test("grok interactiveArgs: pins new Desk chats and resumes by session UUID", () => {
  assert.equal(grokBackend.supportsResume, true);
  assert.equal(grokBackend.pinsSession, true);
  assert.equal(grokBackend.transcriptPerCwd, true);
  assert.equal(grokBackend.headlessResume, true);
  const fresh = grokBackend.interactiveArgs!("grok-4.5", "RULES", [], "sess-uuid", false);
  assert.ok(fresh.includes("--always-approve"));
  assert.deepEqual(fresh.slice(fresh.indexOf("--model"), fresh.indexOf("--model") + 2), ["--model", "grok-4.5"]);
  assert.deepEqual(fresh.slice(fresh.indexOf("--rules"), fresh.indexOf("--rules") + 2), ["--rules", "RULES"]);
  assert.deepEqual(fresh.slice(-2), ["--session-id", "sess-uuid"]);
  assert.deepEqual(
    grokBackend.interactiveArgs!(null, null, [], "sess-uuid", true).slice(-2),
    ["--resume", "sess-uuid"],
  );
  assert.ok(!grokBackend.interactiveArgs!(null).includes("--session-id"));
  assert.ok(!grokBackend.interactiveArgs!(null).includes("--resume"));
});

test("grok buildArgs: --resume vs --session-id like claude", () => {
  const fresh = grokBackend.buildArgs({ goal: "g" } as any, "new-id", null);
  assert.ok(fresh.includes("--session-id") && fresh.includes("new-id"));
  assert.ok(!fresh.includes("--resume"));
  const cont = grokBackend.buildArgs({ goal: "g" } as any, "new-id", null, "old-id");
  assert.ok(cont.includes("--resume") && cont.includes("old-id"));
  assert.ok(!cont.includes("--session-id"));
});

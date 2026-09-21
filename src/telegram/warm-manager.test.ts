import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CONFIG snapshots env at import, so point it at the fake CLI before pulling agent.ts in.
const HERE = path.dirname(fileURLToPath(import.meta.url));
process.env.CHRONOS_CLAUDE_BIN = path.join(HERE, "fake-claude.mjs");

const { WarmManager } = await import("./agent.js");
const { _resetProviderLimitState, isProviderLimited, modelLimitKey, withProviderFallback } = await import("../manager-fallback.js");

const mk = () =>
  new WarmManager({
    system: "test",
    model: "sonnet",
    turnTimeoutMs: 5_000,
    maxTurns: 30,
  });

// The bug: a failed turn makes attempt() SIGKILL the process and immediately respawn for the retry.
// The dead process's 'close' then landed on the RETRY's pending turn and rejected it with
// "manager exited (signal SIGKILL)" — a message the operator never killed, failing for no reason.
test("the retry after a failed turn is not killed by the dead process", async () => {
  const marker = path.join(os.tmpdir(), `chronos-fake-fail-${process.pid}`);
  fs.rmSync(marker, { force: true });
  process.env.CHRONOS_FAKE_FAIL_ONCE = marker;
  try {
    const m = mk();
    assert.equal(await m.turn("hello"), "ok:1", "retry after the first failure must complete");
    m.kill();
  } finally {
    delete process.env.CHRONOS_FAKE_FAIL_ONCE;
    fs.rmSync(marker, { force: true });
  }
});

// --strict-mcp-config with nothing to load means "no MCP servers", so a bundle that never reaches
// argv is indistinguishable from not declaring one: the agent boots fine and simply has no browser.
test("a declared mcp bundle reaches argv; without one, strict still stands alone", async () => {
  const dump = path.join(os.tmpdir(), `chronos-fake-argv-${process.pid}`);
  process.env.CHRONOS_FAKE_ARGV = dump;
  try {
    const cfg = '{"mcpServers":{"playwright":{"command":"node","args":["cli.js"]}}}';
    const withMcp = new WarmManager({ system: "t", model: "sonnet", turnTimeoutMs: 5_000, maxTurns: 30, mcpConfig: cfg });
    await withMcp.turn("hi");
    withMcp.kill();
    let argv = JSON.parse(fs.readFileSync(dump, "utf8")) as string[];
    assert.equal(argv[argv.indexOf("--mcp-config") + 1], cfg);
    assert.ok(argv.indexOf("--mcp-config") < argv.indexOf("--strict-mcp-config"), "strict must come after the config it scopes");

    fs.rmSync(dump, { force: true });
    const plain = mk();
    await plain.turn("hi");
    plain.kill();
    argv = JSON.parse(fs.readFileSync(dump, "utf8")) as string[];
    assert.ok(!argv.includes("--mcp-config"), "an agent with no bundle must not get an --mcp-config");
    assert.ok(argv.includes("--strict-mcp-config"), "strict is unconditional");
  } finally {
    delete process.env.CHRONOS_FAKE_ARGV;
    fs.rmSync(dump, { force: true });
  }
});

test("turns keep working after an abort (killed latch resets)", async () => {
  const m = mk();
  const aborted = m.turn("first").catch((e: Error) => e);
  await new Promise((r) => setTimeout(r, 30)); // let it spawn and start the turn
  m.kill();
  assert.ok((await aborted) instanceof Error, "the aborted turn should reject");
  assert.equal(await m.turn("second"), "ok:1");
  assert.equal(await m.turn("third"), "ok:2");
  m.kill();
});

// The Desk bug: Robert on fable got "You're out of usage credits. Switch to another model to continue."
// and the turn failed outright — the message matched no limit pattern, so withProviderFallback
// rethrew it and attempt() even burned a second fable call on the "dead process" retry. Through the
// real WarmManager: one fable spawn, the same turn answered on opus, and the next turn skips fable.
test("a fable credit wall answers the same turn on opus, once, and stays there for the cooldown", async () => {
  const log = path.join(os.tmpdir(), `chronos-fake-spawns-${process.pid}`);
  fs.rmSync(log, { force: true });
  process.env.CHRONOS_FAKE_WALL_MODEL = "fable";
  process.env.CHRONOS_FAKE_SPAWN_LOG = log;
  _resetProviderLimitState();
  const m = new WarmManager({ system: "t", model: "fable", turnTimeoutMs: 5_000, maxTurns: 30 });
  const swaps: string[] = [];
  const ask = (text: string) =>
    withProviderFallback({
      key: "wm-credit",
      primary: () => m.turn(text, undefined, undefined, "fable"),
      model: "fable",
      primaryOn: (alt) => m.turn(text, undefined, undefined, alt),
      system: "t",
      prompt: text,
      onFallback: (fb) => swaps.push(`${fb.backend}/${fb.model}: ${fb.why}`),
      killPrimary: () => assert.fail("a model wall must not reach the backend swap"),
    });
  try {
    assert.equal(await ask("hola"), "ok:1");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["fable", "opus"], "no retry on the walled model");
    assert.deepEqual(swaps, ["claude/opus: fable sin créditos → opus"]);
    assert.equal(isProviderLimited(modelLimitKey("wm-credit")), true);

    assert.equal(await ask("otra"), "ok:2");
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["fable", "opus"], "cooldown reuses the opus process");
  } finally {
    m.kill();
    delete process.env.CHRONOS_FAKE_WALL_MODEL;
    delete process.env.CHRONOS_FAKE_SPAWN_LOG;
    fs.rmSync(log, { force: true });
    _resetProviderLimitState();
  }
});

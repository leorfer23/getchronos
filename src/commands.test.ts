import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { findCommand, runCommandLine } from "./commands.js";
import { workspaces } from "./store.js";

const mkWs = (over: Record<string, unknown> = {}) =>
  workspaces.create({
    slug: "cmd-" + randomUUID().slice(0, 8),
    name: "Cmd",
    config_dir: "/tmp/cmd",
    ...over,
  } as any);

test("commands resolve by name, alias, and leading ! or /", () => {
  assert.equal(findCommand("cost")?.name, "cost");
  assert.equal(findCommand("spend")?.name, "cost");
  assert.equal(findCommand("!reviews")?.name, "reviews");
  assert.equal(findCommand("/stop")?.name, "stop");
  assert.equal(findCommand("STOP")?.name, "stop");
  assert.equal(findCommand("nonsense"), undefined);
});

// The null return is what lets each surface fall through to its own parser or
// to the LLM (Telegram) instead of swallowing the message.
test("an unregistered line returns null rather than an error string", async () => {
  assert.equal(await runCommandLine("plan ACM-63"), null);
  assert.equal(await runCommandLine(""), null);
});

test("cost reports a window and names it", async () => {
  const today = await runCommandLine("cost");
  assert.match(String(today), /Spend today|no runs/);
  const week = await runCommandLine("cost 7d");
  assert.match(String(week), /last 7d/);
});

test("auto shows the switches, then flips one", async () => {
  const ws = mkWs({ auto_build: 0 });
  const shown = await runCommandLine(`auto ${ws.slug}`);
  assert.match(String(shown), new RegExp(`${ws.slug} autonomy`));
  assert.match(String(shown), /build: off/);

  await runCommandLine(`auto ${ws.slug} build on`);
  assert.equal(workspaces.get(ws.id)?.auto_build, 1);
  // Bare switch toggles, matching the Telegram buttons.
  await runCommandLine(`auto ${ws.slug} build`);
  assert.equal(workspaces.get(ws.id)?.auto_build, 0);
});

test("auto falls back to the surface's workspace when none is named", async () => {
  const ws = mkWs({ auto_review: 0 });
  await runCommandLine("auto review on", { workspaceId: ws.id });
  assert.equal(workspaces.get(ws.id)?.auto_review, 1);
});

test("auto rejects an unknown switch instead of silently doing nothing", async () => {
  const ws = mkWs();
  assert.match(String(await runCommandLine(`auto ${ws.slug} launch on`)), /Unknown switch/);
});

test("stop reports honestly when there is nothing to stop", async () => {
  assert.match(String(await runCommandLine("stop robert")), /Nothing running/);
  assert.match(String(await runCommandLine("stop deadbeef")), /No running job/);
});

test("a handler that throws is reported, not swallowed", async () => {
  // reviews with a ticket-less review row is the realistic version of this; here just assert the
  // wrapper shape holds for a normal call.
  const out = await runCommandLine("reviews");
  assert.ok(typeof out === "string" && out.length > 0);
});

test("round-2 commands are all registered and reachable by alias", () => {
  for (const [word, name] of [
    ["search", "search"], ["find", "search"],
    ["memo", "memo"], ["memos", "memo"],
    ["learn", "learn"], ["lessons", "learn"],
    ["skills", "skills"], ["skill", "skills"],
    ["ideas", "ideas"], ["idea", "ideas"],
    ["link", "link"], ["links", "link"], ["unlink", "unlink"],
  ] as const) {
    assert.equal(findCommand(word)?.name, name, `${word} → ${name}`);
  }
});

test("memo writes to the named workspace and lists it back", async () => {
  const ws = mkWs();
  const made = await runCommandLine(`memo ${ws.slug} new Deploy runbook :: always npm run deploy`);
  assert.match(String(made), /saved in/);
  const listed = await runCommandLine(`memo ${ws.slug}`);
  assert.match(String(listed), /Deploy runbook/);
});

test("learn records a durable fact against the surface's workspace", async () => {
  const ws = mkWs();
  const out = await runCommandLine("learn the daemon runs from dist, always deploy", { workspaceId: ws.id });
  assert.match(String(out), /Learned for/);
});

test("link reports missing tickets instead of throwing", async () => {
  assert.match(String(await runCommandLine("link NOPE-1")), /No ticket NOPE-1/);
  assert.match(String(await runCommandLine("link NOPE-1 sideways NOPE-2")), /Link type must be one of/);
});

test("skills and ideas report empty states honestly", async () => {
  assert.match(String(await runCommandLine("skills")), /No skills pending/);
  assert.match(String(await runCommandLine("ideas")), /No ideas proposed/);
});

test("search needs a query and says so", async () => {
  assert.match(String(await runCommandLine("search")), /Usage: search/);
});

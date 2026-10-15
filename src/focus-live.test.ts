import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveFocusEvents, refreshLiveFocus, startFocus, stopFocus, type FocusCtx } from "./focus.js";

const assistant = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";

test("a live Focus panel reads the incremental tail cache instead of reparsing its transcript", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "focus-live-"));
  const configDir = path.join(root, "profile");
  const sessionId = "live-focus-session";
  const projectDir = path.join(configDir, "projects", "workspace");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, assistant("Understanding: cache the live story"));
  const ctx: FocusCtx = {
    sessionId,
    backend: "claude-code",
    cwd: root,
    configDir,
    sinceMs: Date.now(),
  };

  startFocus(ctx);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(liveFocusEvents(sessionId)?.map((e) => e.text), ["Understanding: cache the live story"]);

  fs.appendFileSync(transcript, assistant("Summary: appended once"));
  assert.deepEqual(
    liveFocusEvents(sessionId)?.map((e) => e.text),
    ["Understanding: cache the live story"],
    "reading the live cache does no synchronous disk backfill",
  );
  assert.deepEqual(
    refreshLiveFocus(sessionId)?.map((e) => e.text),
    ["Understanding: cache the live story", "Summary: appended once"],
  );

  stopFocus(sessionId);
  assert.equal(liveFocusEvents(sessionId), null);
});

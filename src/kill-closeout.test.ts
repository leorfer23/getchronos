/**
 * Closing a terminal must close its ROW — the same way `mc goal done` does.
 *
 * The operator's fear, in his words: "if I close icon and close confirm we will lose the terminal's
 * summary and row". He was right about the mechanism. `killSession` used to mark the row ended and
 * trust the pty's `onExit` to freeze the ledger on its way out, which never happens when there is no
 * live pty to exit — after a daemon restart every row still says `live` while its process is gone.
 *
 * These assert against a real transcript on disk, because the ledger is READ from one: a test that
 * only checked "the row still exists" passes on the broken code too (ending a row never deleted it).
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, sessions, workspaces } from "./store.js";
import { forgetUsage } from "./session-usage.js";
import { killSession } from "./terminal.js";

beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM workspaces;");
});

let n = 0;
/** A session with a claude transcript where snapshotUsage can find it — cwd /tmp → project dir -tmp. */
function sessionWithTranscript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "closeout-"));
  const ws = workspaces.create({ slug: `closeout${++n}`, name: "C", config_dir: dir });
  const s = sessions.create({
    workspace_id: ws.id,
    cwd: "/tmp",
    backend: "claude-code",
    goal: "a job worth logging",
  });
  const proj = path.join(dir, "projects", "-tmp");
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, `${s.id}.jsonl`),
    [
      { type: "user", message: { content: "Goal: open the rollback PR" } },
      { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1000 } } },
      { type: "user", message: { content: "now the second thing" } },
      { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 3, output_tokens: 70, cache_read_input_tokens: 9000 } } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  forgetUsage(s.id); // no cached read from an earlier test
  return s.id;
}

describe("killSession closes the row", () => {
  test("freezes the ledger even though no pty ever exits", () => {
    // THE regression test. `live` is empty (nothing was spawned), which is exactly the state after a
    // daemon restart. Before the fix this took the `if (e)` false branch: the row was marked ended
    // and turns/tokens/cost stayed NULL forever — the terminal showed up in the day's log having
    // apparently done nothing, and its transcript was no longer the newest one to rebuild from.
    const id = sessionWithTranscript();
    assert.equal(sessions.get(id)!.turns, null, "precondition: nothing frozen yet");

    killSession(id);

    const after = sessions.get(id)!;
    assert.equal(after.status, "ended");
    assert.ok(after.ended_at, "ended_at stamped");
    assert.equal(after.turns, 2, "the ledger must be frozen by the close, not by a pty that never exits");
    assert.equal(after.tokens_out, 170);
    assert.equal(after.cache_read, 10000, "Desk cache tokens persist onto the row");
    assert.ok((after.context_peak ?? 0) > 0, "context peak recorded");
  });

  test("the row keeps what identifies it — closing is not clearing", () => {
    // Only the identity/intent columns are asserted here. The ledger numbers are deliberately NOT:
    // the transcript is their sole author (snapshotUsage is the only thing that writes turns,
    // tokens, cost, lines), so a close REPLACING them with what the transcript says is the correct
    // behaviour, not a loss. `context_peak` is the one exception and takes a max, because a peak
    // that regresses would be a lie about how full the window ever got.
    const id = sessionWithTranscript();
    const before = sessions.get(id)!;

    killSession(id);

    const after = sessions.get(id)!;
    assert.equal(after.goal, "a job worth logging");
    assert.equal(after.spawn_goal, "a job worth logging");
    assert.equal(after.created_at, before.created_at);
    assert.equal(after.workspace_id, before.workspace_id);
    assert.equal(after.backend, before.backend);
  });

  test("closing twice is safe — the ✕ arms and can fire more than once", () => {
    const id = sessionWithTranscript();
    killSession(id);
    const first = sessions.get(id)!;
    killSession(id);
    const second = sessions.get(id)!;
    assert.equal(second.status, "ended");
    assert.equal(second.goal, "a job worth logging", "a second close must not clear the row");
    assert.equal(second.turns, first.turns, "and must not corrupt the frozen ledger");
  });

  test("a closed terminal is still in the day's log", () => {
    const id = sessionWithTranscript();
    killSession(id);
    const row = sessions.list().find((r) => r.id === id);
    assert.ok(row, "still listed after being closed");
    assert.equal(row!.status, "ended");
  });
});

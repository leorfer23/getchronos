import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("ensureWsTicketsDir creates the dir a CLI is handed as --add-dir", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-wstickets-"));
  process.env.CHRONOS_HOME = home;
  const { ensureWsTicketsDir, wsTicketsDir } = await import("./sandbox.js");
  const dir = wsTicketsDir("never-ticketed");
  assert.equal(dir, path.join(home, "tickets", "never-ticketed"));
  assert.equal(fs.existsSync(dir), false);
  assert.equal(ensureWsTicketsDir("never-ticketed"), dir);
  assert.equal(fs.statSync(dir).isDirectory(), true);
  assert.equal(ensureWsTicketsDir("never-ticketed"), dir);
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * The Desk picker/card for a cloud terminal, read the same way desk-blank.test.ts reads the spawn
 * dialog: static/desk.html has no build step, so these assertions are the only thing that would
 * catch a regression here — a pty-mount check that silently loses its `cloud_agent_id` guard, or a
 * picker that stops reading `kind`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listBackends } from "./backends/index.js";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("listBackends() exposes kind for the picker to badge — the base every cursor-cloud PR builds on", () => {
  for (const b of listBackends()) assert.ok(b.kind === "local" || b.kind === "cloud", `${b.name} has a kind`);
});

test("the picker badges a cloud backend from kind, not by re-deriving it from the name", () => {
  assert.match(html, /backendKind\(name\)/);
  assert.match(html, /S\.backends\.find\(\(b\) => b\.name === name\)\?\.kind/);
});

test("the picker disables cursor-cloud until the repo's GitHub visibility is confirmed", () => {
  assert.match(html, /backends\/cursor-cloud\/repos/);
  assert.match(html, /opt\.disabled = true/);
});

test("a cloud session never mounts a pty pane, and never forces Terminal mode", () => {
  assert.match(html, /const id = s\?\.live && !s\.focus_only && !s\.cloud_agent_id \? S\.active : null;/);
  assert.match(html, /\(s\.focus_only \|\| s\.cloud_agent_id\) && S\.mode === "term"/);
});

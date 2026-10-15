import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, workspaces, tickets, sessions, reviews, jobs, runs, deletedExternals } from "./store.js";
import { removeTicket } from "./tickets.js";

beforeEach(() => {
  db.exec(
    "DELETE FROM sessions; DELETE FROM reviews; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces; DELETE FROM deleted_externals;"
  );
});

function seedTicket(wsId: string, filePath?: string, external?: { system: string; id: string }) {
  const key = `T-${randomUUID().slice(0, 8)}`;
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(),
    title: key, status: "backlog", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: filePath ?? `/tmp/${key}.md`, external_system: external?.system ?? null,
    external_id: external?.id ?? null, external_url: null, tags: null,
  } as any);
}

test("removeTicket doesn't throw on a ticket with a session and a decided review, and SET NULLs the refs", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const t = seedTicket(ws.id);

  const s = sessions.create({ ticket_id: t.id, workspace_id: ws.id, cwd: "/tmp" });
  const run = runs.create(jobs.create({ name: "test", goal: "g", ticket_id: t.id }).id, "manual");
  // Decided reviews may outlive the ticket (historical); only pending blocks delete (PER-34).
  const r = reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });
  reviews.setState(r.id, "merged", "already shipped", "human");

  assert.doesNotThrow(() => removeTicket(t.id));

  assert.equal(tickets.get(t.id), undefined);
  assert.equal(sessions.get(s.id)?.ticket_id, null);
  assert.equal(reviews.get(r.id)?.ticket_id, null);
});

// PER-34: deleting under a pending review SET NULLs ticket_id; merge then commits but never lands.
test("removeTicket refuses while a pending review still owns the ship path", () => {
  const ws = workspaces.create({ slug: "pendel", name: "PendEl", config_dir: "/tmp/pendel" });
  const t = seedTicket(ws.id);
  const run = runs.create(jobs.create({ name: "test", goal: "g", ticket_id: t.id }).id, "manual");
  reviews.create({ run_id: run.id, ticket_id: t.id, diff_ref: null });

  assert.throws(() => removeTicket(t.id), /pending review/);
  assert.ok(tickets.get(t.id), "ticket must still exist");
  assert.equal(reviews.byTicket(t.id).length, 1);
});

test("removeTicket deletes the ticket's markdown file, and only that file", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-ticket-"));

  const t = seedTicket(ws.id);
  const owned = path.join(dir, `${t.key}.md`);
  fs.writeFileSync(owned, "# body");
  tickets.update(t.id, { file_path: owned });

  // Corrupted file_path (basename doesn't match the key) must be left alone.
  const bystander = path.join(dir, "not-a-ticket.md");
  const foreign = seedTicket(ws.id, bystander);
  fs.writeFileSync(bystander, "keep me");

  removeTicket(t.id);
  removeTicket(foreign.id);

  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(bystander), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

// PER-70 bug 2: deleting a connector-linked ticket used to leave no trace, so the next sync saw the
// external task still untracked locally and recreated it under a fresh key.
test("removeTicket tombstones a connector-linked ticket's external id", () => {
  const ws = workspaces.create({ slug: "acme2", name: "Acme2", config_dir: "/tmp/acme2" });
  const t = seedTicket(ws.id, undefined, { system: "clickup", id: "cu-123" });

  assert.equal(deletedExternals.has(ws.id, "clickup", "cu-123"), false);
  removeTicket(t.id);
  assert.equal(deletedExternals.has(ws.id, "clickup", "cu-123"), true);
});

test("removeTicket does not tombstone a native (non-connector) ticket", () => {
  const ws = workspaces.create({ slug: "acme3", name: "Acme3", config_dir: "/tmp/acme3" });
  const t = seedTicket(ws.id);

  removeTicket(t.id);
  assert.equal(deletedExternals.has(ws.id, "clickup", "cu-999"), false);
});

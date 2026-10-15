import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, jobs, tickets } from "./store.js";

beforeEach(() => {
  db.exec("DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
});

function seedTicket(id: string, workspaceId: string) {
  return tickets.create({
    id, workspace_id: workspaceId, repo_id: null, key: id, slug: id.toLowerCase(),
    title: id, status: "backlog", priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${id}.md`, external_system: null, external_id: null,
    external_url: null, tags: null,
  } as any);
}

test("jobs.ticket_id is a real FK — rejects a ticket_id with no matching ticket row", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  assert.throws(
    () => jobs.create({ name: "ticket:GHOST", goal: "g", workspace_id: ws.id, ticket_id: "no-such-ticket" }),
    /FOREIGN KEY/,
  );
});

test("deleting a ticket sets jobs.ticket_id to NULL instead of orphaning it (PER-44)", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const t = seedTicket("T-1", ws.id);
  const job = jobs.create({ name: "ticket:T-1", goal: "g", workspace_id: ws.id, ticket_id: t.id });

  tickets.remove(t.id);

  const row = db.prepare("SELECT ticket_id FROM jobs WHERE id = ?").get(job.id) as { ticket_id: string | null };
  assert.equal(row.ticket_id, null);
  assert.deepEqual(db.pragma("foreign_key_check(jobs)"), []);
});

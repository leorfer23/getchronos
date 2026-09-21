import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, workspaces, tickets, ticketLinks } from "./store.js";

beforeEach(() => {
  db.exec("DELETE FROM ticket_links; DELETE FROM tickets; DELETE FROM workspaces;");
});

let n = 0;
function seedTicket(wsId: string, status = "backlog") {
  const key = `T-${++n}`;
  return tickets.create({
    id: randomUUID(), workspace_id: wsId, repo_id: null, key, slug: key.toLowerCase(),
    title: key, status, priority: "P2", complexity: null, backend: null, model: null,
    assignee: "agent", file_path: `/tmp/${key}.md`, external_system: null, external_id: null,
    external_url: null, tags: null,
  } as any);
}

test("blockersOpen lists open upstream blockers, clears when they're done", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const a = seedTicket(ws.id, "in_progress");
  const b = seedTicket(ws.id);
  ticketLinks.add(a.id, b.id, "blocks"); // a blocks b

  assert.equal(ticketLinks.blockersOpen(b.id).length, 1);
  assert.equal(ticketLinks.blockersOpen(b.id)[0].id, a.id);
  assert.ok(ticketLinks.blockedIds().has(b.id));

  tickets.update(a.id, { status: "done" } as any);
  assert.equal(ticketLinks.blockersOpen(b.id).length, 0);
  assert.ok(!ticketLinks.blockedIds().has(b.id));
});

test("wouldCycle rejects a blocks/parent cycle but allows relates both ways", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const a = seedTicket(ws.id);
  const b = seedTicket(ws.id);
  ticketLinks.add(a.id, b.id, "blocks"); // a→b
  assert.throws(() => ticketLinks.add(b.id, a.id, "blocks"), /cycle/); // b→a would loop
  assert.throws(() => ticketLinks.add(a.id, a.id, "relates"), /itself/);
  // relates is symmetric / non-hierarchical → no cycle guard
  ticketLinks.add(a.id, b.id, "relates");
});

test("ancestors returns the parent chain root-first, empty for a top-level ticket", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const root = seedTicket(ws.id);
  const mid = seedTicket(ws.id);
  const leaf = seedTicket(ws.id);
  ticketLinks.add(root.id, mid.id, "parent"); // root is parent of mid
  ticketLinks.add(mid.id, leaf.id, "parent"); // mid is parent of leaf

  assert.deepEqual(ticketLinks.ancestors(leaf.id).map((t) => t.id), [root.id, mid.id]);
  assert.deepEqual(ticketLinks.ancestors(mid.id).map((t) => t.id), [root.id]);
  assert.equal(ticketLinks.ancestors(root.id).length, 0);
});

test("forTicket reports direction relative to the ticket", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const a = seedTicket(ws.id);
  const b = seedTicket(ws.id);
  ticketLinks.add(a.id, b.id, "blocks"); // a blocks b

  const fromA = ticketLinks.forTicket(a.id);
  assert.equal(fromA[0].dir, "out");
  assert.equal(fromA[0].ticket.id, b.id);

  const fromB = ticketLinks.forTicket(b.id);
  assert.equal(fromB[0].dir, "in");
  assert.equal(fromB[0].ticket.id, a.id);
});

test("get returns the link row, undefined once removed", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const a = seedTicket(ws.id);
  const b = seedTicket(ws.id);
  const link = ticketLinks.add(a.id, b.id, "relates");

  const got = ticketLinks.get(link.id);
  assert.equal(got?.from_id, a.id);
  assert.equal(got?.to_id, b.id);
  assert.equal(got?.type, "relates");

  ticketLinks.remove(link.id);
  assert.equal(ticketLinks.get(link.id), undefined);
});

test("goal grouping: children() lists a goal's kids, goalIds() flags the goal", () => {
  const ws = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" });
  const goal = seedTicket(ws.id);
  const c1 = seedTicket(ws.id, "done");
  const c2 = seedTicket(ws.id, "in_progress");
  const orphan = seedTicket(ws.id);
  ticketLinks.add(goal.id, c1.id, "parent");
  ticketLinks.add(goal.id, c2.id, "parent");

  const kids = ticketLinks.children(goal.id);
  assert.deepEqual(kids.map((k) => k.id).sort(), [c1.id, c2.id].sort());
  assert.equal(ticketLinks.children(orphan.id).length, 0);

  const goals = ticketLinks.goalIds();
  assert.ok(goals.has(goal.id));
  assert.ok(!goals.has(c1.id)); // a child is not itself a goal
  assert.ok(!goals.has(orphan.id));

  // roll-up the API/mc computes: 1 of 2 done
  assert.equal(kids.filter((k) => k.status === "done").length, 1);
});

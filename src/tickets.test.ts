import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { routeAgent, difficultyOf, parseMarkdown, traceDispatch, createTicket, updateTicket, appendNote, lastLoggedHours, setPlan, gradeTicket } from "./tickets.js";
import { bus } from "./bus.js";
import { parseRouteModels } from "./config.js";
import { workspaces } from "./store.js";

const ws = { default_backend: "claude-code", route_config: null };

const mkWs = () => workspaces.create({ slug: "tk-" + randomUUID().slice(0, 8), name: "Ticket test ws", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);

test("routeAgent maps difficulty 1-5 to the default claude-code model", () => {
  assert.deepEqual(routeAgent({ complexity: "1", backend: null, model: null }, ws), { model: "haiku" });
  assert.deepEqual(routeAgent({ complexity: "3", backend: null, model: null }, ws), { model: "sonnet" });
  assert.deepEqual(routeAgent({ complexity: "5", backend: null, model: null }, ws), { model: "opus" });
});

test("difficultyOf normalizes legacy grades and defaults null/garbage to 3", () => {
  assert.equal(difficultyOf(null), 3);
  assert.equal(difficultyOf("trivial"), 1);
  assert.equal(difficultyOf("hard"), 4);
  assert.equal(difficultyOf("4"), 4);
  assert.equal(difficultyOf("huge"), 3);
});

test("ungraded ticket routes at the default difficulty 3", () => {
  assert.deepEqual(routeAgent({ complexity: null, backend: null, model: null }, ws), { model: "sonnet" });
});

test("routeAgent global fallback only routes claude-code backends", () => {
  assert.deepEqual(routeAgent({ complexity: "5", backend: "cursor-agent", model: null }, ws), {});
  assert.deepEqual(routeAgent({ complexity: "5", backend: null, model: null }, { default_backend: "cursor-agent", route_config: null }), {});
  // ticket override back to claude-code beats a non-claude ws default → route
  assert.deepEqual(routeAgent({ complexity: "5", backend: "claude-code", model: null }, { default_backend: "cursor-agent", route_config: null }), { model: "opus" });
});

test("per-workspace route_config wins and can cross backends", () => {
  const rc = { default_backend: "claude-code", route_config: JSON.stringify({ "5": "opencode:vercel/moonshotai/kimi-k3", "1": "haiku" }) };
  assert.deepEqual(routeAgent({ complexity: "5", backend: null, model: null }, rc), { backend: "opencode", model: "vercel/moonshotai/kimi-k3" });
  assert.deepEqual(routeAgent({ complexity: "1", backend: null, model: null }, rc), { model: "haiku" });
});

test("explicit ticket.model wins — routeAgent stays out of the way", () => {
  assert.deepEqual(routeAgent({ model: "opus-custom", complexity: "1", backend: null }, ws), {});
});

test("parseRouteModels parses a spec and env override drops the trivial rung", () => {
  assert.deepEqual(parseRouteModels("trivial=haiku,easy=sonnet,medium=opus,hard=opus"), {
    trivial: "haiku", easy: "sonnet", medium: "opus", hard: "opus",
  });
  const over = parseRouteModels("easy=sonnet, medium=sonnet, hard=opus");
  assert.deepEqual(over, { easy: "sonnet", medium: "sonnet", hard: "opus" });
  assert.equal(over.trivial, undefined); // ungraded rung absent → routeAgent falls through to ws default
});

test("complexity survives the frontmatter round-trip (parse reads the serialized field)", () => {
  const md = ["---", "id: ACM-9", "priority: P1", "complexity: medium", "status: planned", "---", "", "body"].join("\n");
  assert.equal(parseMarkdown(md).meta.complexity, "medium");
});

test("traceDispatch publishes the outcomes that never produce a run", async () => {
  const seen: Array<{ ticket_id: string; text: string }> = [];
  const listen = (e: any) => { if (e.topic === "ticket.event") seen.push(e); };
  bus.on("event", listen);
  try {
    // pre-flight throw: no job, no run — the only trace of the attempt
    await assert.rejects(
      () => traceDispatch("build", async () => { throw new Error("blocked by ACM-1"); })("t1"),
      /blocked by ACM-1/,
    );
    assert.equal(seen.length, 1);
    assert.match(seen[0].text, /build.*dispatch failed.*blocked by ACM-1/);
    assert.equal(seen[0].ticket_id, "t1");

    // dispatcher answered but nothing runs (budget cap)
    traceDispatch("plan", () => ({ job_id: "j", run_id: "r", status: "blocked" }))("t2");
    assert.equal(seen.length, 2);
    assert.match(seen[1].text, /plan.*never started.*blocked/);

    // the happy path stays quiet — run.started speaks for it
    traceDispatch("build", () => ({ job_id: "j", run_id: "r", status: "queued" }))("t3");
    assert.equal(seen.length, 2);

    // a review dispatches by review id — the thread it belongs to comes from the resolver
    traceDispatch("AI review", () => ({ status: "error: no repo" }), () => "t4")("rev1");
    assert.equal(seen[2].ticket_id, "t4");
  } finally {
    bus.off("event", listen);
  }
});

test("lastLoggedHours picks the most recent 'Logged Nh.' note (newest notes are prepended)", () => {
  const t = createTicket({ workspace_id: mkWs().id, title: "Ship the widget" });
  appendNote(t.id, "Logged 3h. Started investigation.");
  const withFirst = appendNote(t.id, "Logged 8h. Wrapped up and closing.")!;
  assert.equal(lastLoggedHours(withFirst), 8);
});

test("lastLoggedHours returns null when no note logs hours", () => {
  const t = createTicket({ workspace_id: mkWs().id, title: "No hours logged" });
  const withNote = appendNote(t.id, "just a status update, no hours here")!;
  assert.equal(lastLoggedHours(withNote), null);
});

test("key sequence is global per PREFIX, not per workspace — 'personal' and 'presence' both map to PER", () => {
  const suffix = randomUUID().slice(0, 6);
  // Distinct slugs, same 3-letter prefix (wsPrefix takes slug[0:3] uppercased).
  const a = workspaces.create({ slug: `xqa-one-${suffix}`, name: "A", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);
  const b = workspaces.create({ slug: `xqa-two-${suffix}`, name: "B", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);
  const t1 = createTicket({ workspace_id: a.id, title: "first" });
  const t2 = createTicket({ workspace_id: b.id, title: "second" }); // other workspace, same XQA prefix
  const t3 = createTicket({ workspace_id: a.id, title: "third" });
  const num = (k: string) => +/-(\d+)$/.exec(k)![1];
  assert.equal(t2.key.startsWith("XQA-"), true);
  // No duplicates: each new key strictly increases across BOTH workspaces sharing the prefix.
  assert.ok(num(t2.key) > num(t1.key), `${t2.key} must be > ${t1.key}`);
  assert.ok(num(t3.key) > num(t2.key), `${t3.key} must be > ${t2.key}`);
});

test("createTicket defaults status_source to 'local' — only an explicit override changes it", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "native ticket" });
  assert.equal(t.status_source, "local");

  const mirror = createTicket({ workspace_id: ws.id, title: "mirrored ticket", status_source: "external" });
  assert.equal(mirror.status_source, "external");
});

test("updateTicket: status_source choke point — defaults to 'local' whenever status changes, leaves it alone otherwise", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "t", status_source: "external" });
  assert.equal(t.status_source, "external");

  // A patch that doesn't touch status must not touch status_source either.
  const titleOnly = updateTicket(t.id, { title: "renamed" })!;
  assert.equal(titleOnly.status_source, "external");

  // Any status change defaults to 'local' unless the caller explicitly says otherwise (only
  // connector sync does).
  const moved = updateTicket(t.id, { status: "in_progress" })!;
  assert.equal(moved.status_source, "local");

  // A caller CAN still say 'external' explicitly (this is what connector sync does).
  const backToMirror = updateTicket(t.id, { status: "ready", status_source: "external" })!;
  assert.equal(backToMirror.status_source, "external");
});

test("createTicket defaults complexity_source to 'human' whenever complexity is set on create — null otherwise", () => {
  const ws = mkWs();
  const graded = createTicket({ workspace_id: ws.id, title: "operator-graded ticket", complexity: "4" });
  assert.equal(graded.complexity_source, "human");

  const ungraded = createTicket({ workspace_id: ws.id, title: "ungraded ticket" });
  assert.equal(ungraded.complexity, null);
  assert.equal(ungraded.complexity_source, null);

  // An explicit override (only setPlan/gradeTicket do this internally) still wins.
  const scouted = createTicket({ workspace_id: ws.id, title: "scout-seeded", complexity: "2", complexity_source: "scout" });
  assert.equal(scouted.complexity_source, "scout");
});

test("updateTicket: complexity_source choke point — the generic PATCH defaults to 'human' whenever complexity changes", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "t" });
  assert.equal(t.complexity_source, null);

  // A patch that doesn't touch complexity must not touch complexity_source either.
  const titleOnly = updateTicket(t.id, { title: "renamed" })!;
  assert.equal(titleOnly.complexity_source, null);

  // `mc ticket update --difficulty` / API PATCH → complexity changes → 'human' unless the caller says otherwise.
  const graded = updateTicket(t.id, { complexity: "3" })!;
  assert.equal(graded.complexity, "3");
  assert.equal(graded.complexity_source, "human");
});

test("setPlan (scout) grades complexity as 'scout' — but never overwrites a human-authoritative value", () => {
  const ws = mkWs();
  const scouted = createTicket({ workspace_id: ws.id, title: "fresh ticket" });
  const planned = setPlan(scouted.id, "investigated the code, here's the brief", { complexity: "4" })!;
  assert.equal(planned.complexity, "4");
  assert.equal(planned.complexity_source, "scout");
  assert.equal(planned.status, "planned");

  const humanGraded = createTicket({ workspace_id: ws.id, title: "leo-graded ticket", complexity: "5" });
  assert.equal(humanGraded.complexity_source, "human");
  const stillHuman = setPlan(humanGraded.id, "scout brief", { complexity: "2" })!;
  assert.equal(stillHuman.complexity, "5", "scout's grade must not overwrite the operator's");
  assert.equal(stillHuman.complexity_source, "human");
});

test("gradeTicket: normal case grades 'grader' and logs a note", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "scouted, awaiting grade" });
  const graded = gradeTicket(t.id, 4, "cross-cutting change across the dispatcher")!;
  assert.equal(graded.complexity, "4");
  assert.equal(graded.complexity_source, "grader");
});

test("gradeTicket: refuses to overwrite a human-set complexity — never throws, doesn't touch the value", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "leo already graded this", complexity: "1" });
  assert.equal(t.complexity_source, "human");

  const result = gradeTicket(t.id, 5, "actually this looks architectural")!;
  assert.equal(result.complexity, "1", "grader must not overwrite the operator's call");
  assert.equal(result.complexity_source, "human");
});

test("NewTicketSchema accepts description/body (mc ticket new --body) instead of silently stripping them", async () => {
  const { NewTicketSchema } = await import("./validation.js");
  const parsed = NewTicketSchema.parse({ workspace_id: randomUUID(), title: "t", description: "the spec", body: "alt" });
  assert.equal(parsed.description, "the spec");
  assert.equal(parsed.body, "alt");
});

test("updateTicket serializes an array of tags — the shape PatchTicketSchema accepts", () => {
  const ws = mkWs();
  const t = createTicket({ workspace_id: ws.id, title: "tagged", tags: ["one", "two"] });
  assert.equal(t.tags, JSON.stringify(["one", "two"]), "createTicket already stored JSON");

  // PATCH /tickets/:id validates `tags` as string[], and every caller sending that shape used to
  // hit "SQLite3 can only bind numbers, strings, bigints, buffers, and null" from the raw bind.
  const updated = updateTicket(t.id, { tags: ["three"] } as any)!;
  assert.equal(updated.tags, JSON.stringify(["three"]));
  // Already-serialized strings (connector sync) and explicit clears keep working.
  assert.equal(updateTicket(t.id, { tags: JSON.stringify(["four"]) })!.tags, JSON.stringify(["four"]));
  assert.equal(updateTicket(t.id, { tags: null })!.tags, null);
});

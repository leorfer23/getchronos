import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { callerScope } from "./authz.js";
import {
  BACKOFF_MIN_DECIDED, PENDING_MS, belowBar, bucketOf, engagement, flushOperatorInputs, handTyped, noteOperatorInput,
  proactiveAllowed, proactiveKind, proactiveStats, resetProactiveScore, setOperatorInputWriter, INPUT_FLUSH_MS,
} from "./proactive-score.js";
import { db, kv, sessions, workspaces } from "./store.js";
import { writeSetting } from "./settings.js";

beforeEach(() => {
  resetProactiveScore();
  flushOperatorInputs();
  setOperatorInputWriter(null);
});

const HOUR = 60 * 60_000;
const rnd = () => Math.random().toString(36).slice(2, 8);
const mkWs = (slug = `acme-${rnd()}`) => workspaces.create({ slug, name: "Acme", config_dir: "/tmp/acme" } as any);

type Seed = {
  created_by?: string | null;
  tags?: string[] | null;
  ageMs?: number;
  ended?: boolean;
  inputs?: number;
  done?: boolean;
  outcome?: boolean;
};
/** One terminal, backdated and shaped by hand — nothing spawns. */
function seed(wsId: string, o: Seed = {}, nowMs = Date.now()): string {
  const s = sessions.create({ workspace_id: wsId, cwd: "/tmp", backend: "claude-code", created_by: o.created_by ?? "inbox" } as any);
  const created = new Date(nowMs - (o.ageMs ?? HOUR)).toISOString();
  db.prepare(
    "UPDATE sessions SET created_at=?, tags=?, status=?, ended_at=?, operator_inputs=?, goal_done_at=?, outcome=? WHERE id=?",
  ).run(
    created,
    o.tags ? JSON.stringify(o.tags) : null,
    o.ended ? "ended" : "live",
    o.ended ? created : null,
    o.inputs ?? 0,
    o.done ? created : null,
    o.outcome ? JSON.stringify({ summary: "did it" }) : null,
    s.id,
  );
  return s.id;
}
const many = (n: number, wsId: string, o: Seed) => Array.from({ length: n }, () => seed(wsId, o));

// ──────────────────────────── kinds and buckets ────────────────────────────

test("proactiveKind: who opened it; the operator's own, failovers and handoffs are not offers", () => {
  assert.equal(proactiveKind({ created_by: "operator" }), null);
  assert.equal(proactiveKind({ created_by: null }), null);
  assert.equal(proactiveKind({ created_by: "failover" }), null);
  assert.equal(proactiveKind({ created_by: "handoff" }), null);
  assert.equal(proactiveKind({ created_by: "inbox" }), "inbox");
  assert.equal(proactiveKind({ created_by: "ship" }), "ship");
  assert.equal(proactiveKind({ created_by: "job-check" }), "job-check");
  assert.equal(proactiveKind({ created_by: "follow-up" }), "follow-up");
  assert.equal(proactiveKind({ created_by: "continuation" }), "continuation");
  assert.equal(proactiveKind({ created_by: "lead:abcd1234" }), "lead");
  assert.equal(proactiveKind({ created_by: "robert" }), "robert");
  assert.equal(proactiveKind({ created_by: "robert", tags: '["proactive","pr"]' }), "proactive");
  assert.equal(proactiveKind({ created_by: "robert", tags: ["proactive"] }), "proactive");
  assert.equal(proactiveKind({ created_by: "robert", tags: "proactive, pr" }), "proactive", "a plain comma list too");
  assert.equal(proactiveKind({ created_by: "inbox", tags: '["proactive"]' }), "inbox", "only Robert's are proactive");
});

test("bucketOf: engaged beats useful beats ignored; live and untouched is pending until 24h", () => {
  const now = Date.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const base = { status: "live", created_at: at(HOUR), goal_done_at: null, outcome: null, operator_inputs: 0 };
  assert.equal(bucketOf({ ...base, operator_inputs: 3, goal_done_at: at(1) }, now), "engaged");
  assert.equal(bucketOf({ ...base, goal_done_at: at(1) }, now), "useful");
  assert.equal(bucketOf({ ...base, outcome: '{"summary":"x"}' }, now), "useful");
  assert.equal(bucketOf({ ...base, status: "ended" }, now), "ignored");
  assert.equal(bucketOf(base, now), "pending");
  assert.equal(bucketOf({ ...base, created_at: at(PENDING_MS - 1) }, now), "pending", "a hair under 24h");
  assert.equal(bucketOf({ ...base, created_at: at(PENDING_MS) }, now), "ignored", "24h untouched is ignored");
});

test("engagement: per workspace × kind over the window; operator and failover rows are left out", () => {
  const ws = mkWs();
  const now = Date.now();
  seed(ws.id, { inputs: 2, ended: true });                 // engaged
  seed(ws.id, { done: true, ended: true });                // useful
  seed(ws.id, { outcome: true });                          // useful (still live)
  seed(ws.id, { ended: true });                            // ignored
  seed(ws.id, { ageMs: 30 * HOUR });                       // ignored: live, untouched 24h+
  seed(ws.id, { ageMs: 2 * HOUR });                        // pending
  seed(ws.id, { ended: true, ageMs: 8 * 24 * HOUR });      // outside 7d
  seed(ws.id, { created_by: "operator", ended: true });
  seed(ws.id, { created_by: "failover", ended: true });
  seed(ws.id, { created_by: "lead:1234abcd", inputs: 1 });
  const rows = engagement({ workspace_id: ws.id, nowMs: now });
  const inbox = rows.find((r) => r.kind === "inbox")!;
  assert.deepEqual(
    { opened: inbox.opened, engaged: inbox.engaged, useful: inbox.useful, ignored: inbox.ignored, pending: inbox.pending, decided: inbox.decided },
    { opened: 6, engaged: 1, useful: 2, ignored: 2, pending: 1, decided: 5 },
  );
  assert.equal(inbox.rate, 3 / 5);
  assert.equal(inbox.workspace, ws.slug);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["inbox", "lead"]);
  assert.equal(engagement({ workspace_id: ws.id, nowMs: now, days: 10 }).find((r) => r.kind === "inbox")!.opened, 7);
});

// ──────────────────────────── the gate ────────────────────────────

test("proactiveAllowed: 7 decided → allowed even at 0%; 8 at 25% → off; 8 at 38% → on", () => {
  const a = mkWs();
  many(7, a.id, { created_by: "ship", ended: true });
  many(3, a.id, { created_by: "ship" }); // pending: never counted
  assert.equal(proactiveAllowed("ship", a.id), true, "7 decided is too few to judge");

  const b = mkWs();
  many(2, b.id, { created_by: "ship", inputs: 1, ended: true });
  many(6, b.id, { created_by: "ship", ended: true });
  assert.equal(proactiveAllowed("ship", b.id), false, "2/8 = 25%");

  const c = mkWs();
  many(3, c.id, { created_by: "ship", inputs: 1, ended: true });
  many(5, c.id, { created_by: "ship", ended: true });
  assert.equal(proactiveAllowed("ship", c.id), true, "3/8 = 37.5%");

  const d = mkWs();
  many(BACKOFF_MIN_DECIDED, d.id, { created_by: "robert", tags: ["proactive"], ended: true });
  assert.equal(proactiveAllowed("proactive", d.id), false, "Robert's proactive terminals are gated too");
});

test("proactiveAllowed: ungated kinds are measured, never stopped", () => {
  const ws = mkWs();
  many(12, ws.id, { created_by: "inbox", ended: true });
  assert.equal(belowBar(engagement({ workspace_id: ws.id }).find((r) => r.kind === "inbox")), true);
  assert.equal(proactiveAllowed("inbox", ws.id), true);
  assert.equal(proactiveAllowed("job-check", ws.id), true);
});

test("proactiveAllowed: recovers when the week improves, and logs the flip once per flip", () => {
  const ws = mkWs();
  const ids = many(8, ws.id, { created_by: "ship", ended: true });
  const logs: string[] = [];
  const spy = mock.method(console, "log", (...a: unknown[]) => { logs.push(a.join(" ")); });
  try {
    assert.equal(proactiveAllowed("ship", ws.id), false);
    assert.equal(proactiveAllowed("ship", ws.id), false);
    assert.equal(logs.filter((l) => l.includes("backing off")).length, 1, "one line, not one per pass");
    db.prepare("UPDATE sessions SET operator_inputs=1 WHERE id IN (?,?,?)").run(ids[0], ids[1], ids[2]);
    assert.equal(proactiveAllowed("ship", ws.id), true, "no sticky state: the query is the state");
    db.prepare("UPDATE sessions SET operator_inputs=0 WHERE id IN (?,?,?)").run(ids[0], ids[1], ids[2]);
    assert.equal(proactiveAllowed("ship", ws.id), false);
    assert.equal(logs.filter((l) => l.includes("backing off")).length, 2, "a fresh flip logs again");
  } finally {
    spy.mock.restore();
  }
});

test("robert.proactive_autotune off → always allowed", () => {
  const ws = mkWs();
  many(10, ws.id, { created_by: "ship", ended: true });
  writeSetting("robert.proactive_autotune", false, ws.id);
  try {
    assert.equal(proactiveAllowed("ship", ws.id), true);
    const body = proactiveStats({ ws: null }, { workspace: ws.id }).body as any;
    assert.equal(body.rows[0].backed_off, false, "the stats say so too");
    assert.equal(body.rows[0].below_bar, true);
  } finally {
    writeSetting("robert.proactive_autotune", null, ws.id);
  }
  assert.equal(proactiveAllowed("ship", ws.id), false);
});

// ──────────────────────────── operator engagement, persisted ────────────────────────────

test("noteOperatorInput: first input written at once, the rest debounced into one write", () => {
  const writes: Array<[string, number]> = [];
  setOperatorInputWriter((id, n) => writes.push([id, n]));
  for (let i = 0; i < 50; i++) noteOperatorInput("s-1", 1_000 + i);
  noteOperatorInput("s-2", 1_000);
  assert.deepEqual(writes, [["s-1", 1], ["s-2", 1]], "a keystroke stream is not 50 writes");
  flushOperatorInputs();
  assert.deepEqual(writes, [["s-1", 1], ["s-2", 1], ["s-1", 49]], "nothing lost: 1 + 49");
  noteOperatorInput("s-1", 99_000);
  assert.deepEqual(writes.at(-1), ["s-1", 1], "after a flush the next input writes at once again");
});

test("noteOperatorInput: the window closes on a timer, then forgets the terminal", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const writes: Array<[string, number, string]> = [];
    setOperatorInputWriter((id, n, at) => writes.push([id, n, at]));
    noteOperatorInput("s-t", 0);
    noteOperatorInput("s-t", 5_000);
    noteOperatorInput("s-t", 6_000);
    assert.equal(writes.length, 1);
    mock.timers.tick(INPUT_FLUSH_MS);
    assert.deepEqual(writes[1], ["s-t", 2, new Date(6_000).toISOString()], "carries the last input's time");
    mock.timers.tick(INPUT_FLUSH_MS); // a quiet window: no write, the entry is dropped
    assert.equal(writes.length, 2);
    noteOperatorInput("s-t", 100_000);
    assert.equal(writes.length, 3, "a new burst writes its first input at once");
  } finally {
    flushOperatorInputs();
    mock.timers.reset();
  }
});

test("noteOperatorInput persists to the session row and turns an offer into engaged", () => {
  const ws = mkWs();
  const id = seed(ws.id, { created_by: "ship", ended: true });
  for (let i = 0; i < 5; i++) noteOperatorInput(id, Date.parse("2026-11-05T10:00:00Z") + i);
  flushOperatorInputs();
  const row = db.prepare("SELECT operator_inputs, operator_last_in FROM sessions WHERE id=?").get(id) as any;
  assert.equal(row.operator_inputs, 5);
  assert.equal(row.operator_last_in, "2026-11-05T10:00:00.004Z");
  assert.equal(engagement({ workspace_id: ws.id }).find((r) => r.kind === "ship")!.engaged, 1);
});

test("handTyped: his keys count; xterm's own ESC replies (cursor, focus, mouse) do not", () => {
  assert.equal(handTyped("a"), true);
  assert.equal(handTyped("\r"), true);
  assert.equal(handTyped("\x7f"), true);
  assert.equal(handTyped("\x1b[12;40R"), false, "cursor position report");
  assert.equal(handTyped("\x1b[I"), false, "focus in");
  assert.equal(handTyped("\x1b[<64;10;5M"), false, "mouse wheel");
  assert.equal(handTyped(""), false);
  assert.equal(handTyped(42), false);
});

test("the operator-input hooks sit on his paths only, never inside sendInput", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (f: string) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");
  const api = read("api.ts");
  assert.match(api, /if \(handTyped\(m\.d\)\) noteOperatorInput\(id\);/, "the Desk pane websocket");
  assert.match(api, /if \(admin && \(req\.body\.by \|\| "operator"\) === "operator"\) noteOperatorInput\(s\.id\);/, "/input, admin + his by");
  assert.match(api, /if \(ask\.session_id && by === "operator" && tokenOk\(req\.get\("x-mc-admin"\), CONFIG\.adminToken\)\) noteOperatorInput\(ask\.session_id\);/, "his answer to a terminal's ask from the Desk or phone");
  const term = read("terminal.ts");
  const send = term.slice(term.indexOf("export function sendInput("), term.indexOf("export function resize("));
  assert.ok(send.length > 0 && !send.includes("noteOperatorInput"), "sendInput is every hand's door — counting there would count Robert");
});

// ──────────────────────────── the read surface ────────────────────────────

function fakeReq(headers: Record<string, string> = {}): any {
  return { get: (h: string) => headers[h.toLowerCase()] };
}

test("stats: a workspace token reads only its own workspace; naming another is a 404", () => {
  const a = mkWs(`initech-${rnd()}`);
  const b = mkWs();
  seed(a.id, { created_by: "inbox", ended: true });
  seed(b.id, { created_by: "inbox", ended: true });
  const scope = callerScope(fakeReq({ "x-mc-workspace-token": a.token }));
  const own = proactiveStats(scope, {});
  assert.equal(own.status, 200);
  assert.ok((own.body as any).rows.length > 0);
  assert.ok((own.body as any).rows.every((r: any) => r.workspace_id === a.id));
  assert.equal(proactiveStats(scope, { workspace: a.slug }).status, 200);
  for (const ref of [b.id, b.slug]) {
    const r = proactiveStats(scope, { workspace: ref });
    assert.equal(r.status, 404, `workspace=${ref} leaked`);
    assert.doesNotMatch(JSON.stringify(r.body), new RegExp(b.id));
  }
  assert.equal(proactiveStats(callerScope(fakeReq({ "x-mc-workspace-token": "nope" })), {}).status, 401);
});

test("stats: admin reads every workspace or one by id or slug; BACKED OFF only on gated kinds", () => {
  const a = mkWs();
  const b = mkWs();
  many(8, a.id, { created_by: "ship", ended: true });
  many(8, a.id, { created_by: "inbox", ended: true });
  seed(b.id, { created_by: "inbox", ended: true });
  const admin = callerScope(fakeReq({ "x-mc-admin": CONFIG.adminToken }));
  const all = (proactiveStats(admin, {}).body as any).rows;
  assert.ok(all.some((r: any) => r.workspace_id === a.id) && all.some((r: any) => r.workspace_id === b.id));
  const bySlug = proactiveStats(admin, { workspace: a.slug, days: "14" }).body as any;
  assert.equal(bySlug.days, 14);
  const ship = bySlug.rows.find((r: any) => r.kind === "ship");
  const inbox = bySlug.rows.find((r: any) => r.kind === "inbox");
  assert.equal(ship.backed_off, true);
  assert.equal(inbox.backed_off, false, "inbox is measured only");
  assert.equal(inbox.below_bar, true);
  assert.equal(proactiveStats(admin, { workspace: "no-such-ws" }).status, 404);
});

test("rows from before counting began (migration 154 on an existing DB) are not judged", () => {
  const ws = mkWs();
  many(8, ws.id, { created_by: "ship", ended: true, ageMs: 3 * 24 * HOUR });
  assert.equal(proactiveAllowed("ship", ws.id), false);
  kv.set("proactive.counted_since", new Date(Date.now() - 2 * 24 * HOUR).toISOString());
  try {
    assert.equal(engagement({ workspace_id: ws.id }).length, 0);
    assert.equal(proactiveAllowed("ship", ws.id), true);
    assert.ok((proactiveStats({ ws: null }, { workspace: ws.id }).body as any).counted_since);
  } finally {
    kv.del("proactive.counted_since");
  }
});

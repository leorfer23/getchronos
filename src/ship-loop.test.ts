import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MAX_NEW_PER_HOUR, ORIGIN_IDLE_MS, heldElsewhere, mentionsPr, originReleased, prReady, resetShipLoop,
  shipBrief, shipGoal, shipPass, standingOrders, type ShipDeps,
} from "./ship-loop.js";
import { SHIP_BY } from "./ship-guard.js";
import { db, sessions, sessionPrs, workspaces } from "./store.js";
import { resetProactiveScore } from "./proactive-score.js";
import { settingOn, writeSetting } from "./settings.js";
import type { SessionPr } from "./store/session-prs.js";
import type { TermStatus } from "./term-status.js";

beforeEach(() => { resetShipLoop(); resetProactiveScore(); });

const HOUR = 60 * 60_000;
const rnd = () => Math.random().toString(36).slice(2, 8);
let n = 1000;
const prUrl = (repo = "repo") => `https://github.com/acme/${repo}/pull/${++n}`;
const mkWs = (auto = false) =>
  workspaces.create({ slug: `sl-${rnd()}`, name: "Acme", config_dir: "/tmp/cfg", auto_merge_prs: auto } as any);
const mkSess = (wsId: string, extra: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, cwd: "/tmp", backend: "claude-code", ...extra } as any);

/** A row the poll has seen green. */
function greenRow(wsId: string, sessionId: string, patch: Partial<SessionPr> = {}, url = prUrl()): string {
  sessionPrs.record({ url, session_id: sessionId, workspace_id: wsId, cwd: "/tmp" });
  sessionPrs.update(url, { ci_state: "passing", title: "Add the thing", ...patch } as any);
  return url;
}

const st = (phase: TermStatus["phase"], since: number, on: TermStatus["on"] = null): TermStatus =>
  ({ phase, since, on, line: "", word: phase, needs_you: false, eta_at: null, subagents: 0, progress: null, hooked: true }) as TermStatus;

type Calls = { opened: any[]; sent: Array<[string, string]> };
/** Every seam faked: nothing spawns, nothing types. `liveIds` are the ptys the daemon "holds". */
function deps(calls: Calls, over: Partial<ShipDeps> & { liveIds?: Set<string>; statuses?: Record<string, TermStatus> } = {}): ShipDeps {
  return {
    opener: (async (o: any) => {
      calls.opened.push(o);
      const s = mkSess(o.workspace_id, { created_by: o.created_by, goal: o.goal });
      over.liveIds?.add(s.id);
      return s;
    }) as any,
    send: (id, text) => { calls.sent.push([id, text]); return null; },
    status: (id) => over.statuses?.[id] ?? null,
    lastIn: () => null,
    owns: () => false,
    feed: () => [],
    openAsks: () => 0,
    enabled: () => false, // every pass test names its own workspace: rows from earlier tests stay out
    orders: () => null,
    ...over,
  };
}
const fresh = (): Calls => ({ opened: [], sent: [] });
const only = (...ids: string[]) => (id: string) => ids.includes(id);

// ──────────────────────────── the predicates ────────────────────────────

test("prReady: open, not draft, green or no-CI, no changes requested, recent, not offered", () => {
  const now = Date.now();
  const base = {
    url: prUrl(), session_id: "s", workspace_id: "w", cwd: "/tmp", state: "open", ci_state: "passing", skip_reason: null,
    merge_error: null, title: "t", review_decision: null, mergeable: "MERGEABLE", draft: 0, no_ci: 0,
    ship_offered_at: null, ship_session_id: null, created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
  } as SessionPr;
  assert.equal(prReady(base, now), null);
  assert.equal(prReady({ ...base, ci_state: null, no_ci: 1 }, now), null, "no CI after the grace is ready");
  assert.match(prReady({ ...base, ci_state: null }, now)!, /CI/, "no checks yet, grace not over");
  assert.match(prReady({ ...base, ci_state: "pending" }, now)!, /CI pending/);
  assert.match(prReady({ ...base, ci_state: "failing" }, now)!, /CI failing/);
  assert.equal(prReady({ ...base, draft: 1 }, now), "draft");
  assert.equal(prReady({ ...base, review_decision: "CHANGES_REQUESTED" }, now), "changes requested");
  assert.equal(prReady({ ...base, review_decision: "APPROVED" }, now), null);
  assert.equal(prReady({ ...base, ship_offered_at: new Date(now).toISOString() }, now), "already offered");
  assert.equal(prReady({ ...base, state: "skipped" }, now), "state skipped");
  assert.match(prReady({ ...base, created_at: new Date(now - 15 * 24 * HOUR).toISOString() }, now)!, /14 days/);
});

test("originReleased: ended → yes; live → only stopped 2h+, untouched, not his", () => {
  const now = Date.now();
  const idle = { live: true, status: st("your_turn", now - ORIGIN_IDLE_MS - 1), operatorOwns: false, lastIn: null };
  assert.equal(originReleased({ live: false, status: null, operatorOwns: false, lastIn: null }, now), true);
  assert.equal(originReleased(idle, now), true);
  assert.equal(originReleased({ ...idle, status: st("working", now - 5 * HOUR) }, now), false, "working");
  assert.equal(originReleased({ ...idle, status: st("waiting", now - 5 * HOUR, "ci") }, now), false, "waiting on CI comes back by itself");
  assert.equal(originReleased({ ...idle, status: st("your_turn", now - HOUR) }, now), false, "stopped only an hour");
  assert.equal(originReleased({ ...idle, operatorOwns: true }, now), false, "he is typing in it");
  assert.equal(originReleased({ ...idle, lastIn: now - 10 * 60_000 }, now), false, "someone typed into it recently");
  assert.equal(originReleased({ ...idle, status: null }, now), false, "no status is not evidence");
});

test("mentionsPr: URL or owner/repo#N anywhere; bare #N only where the operator wrote it", () => {
  const url = "https://github.com/acme/app/pull/264";
  assert.equal(mentionsPr(`see ${url}`, url, false), true);
  assert.equal(mentionsPr("merging acme/app#264 now", url, false), true);
  assert.equal(mentionsPr("merge + deploy PR #264", url, false), false);
  assert.equal(mentionsPr("merge + deploy PR #264", url, true), true);
  assert.equal(mentionsPr("merge pr 264", url, true), true);
  assert.equal(mentionsPr("merge #2645", url, true), false);
  assert.equal(mentionsPr("acme/app#2640", url, false), false);
});

test("standingOrders: the section verbatim, case-insensitive, up to the next ## heading", () => {
  const body = "# Brief\n\n## What this is\nx\n\n## STANDING ORDERS\n- after merge: `npm run deploy`\n### detail\nverify /health\n\n## Next\nstuff";
  assert.equal(standingOrders(body), "- after merge: `npm run deploy`\n### detail\nverify /health");
  assert.equal(standingOrders("## Standing orders\n\n## Next\n"), null);
  assert.equal(standingOrders("# no section"), null);
  // The brief's seed template: labels nobody filled are not orders.
  const seeded = "## Standing orders\n- Ship:\n- After merge:\n- Robert may do alone:\n- Ask first:\n- Never:\n\n## Recently\n";
  assert.equal(standingOrders(seeded), null);
  assert.equal(standingOrders(seeded.replace("- Ship:", "- Ship: merge, then deploy")), "- Ship: merge, then deploy");
  assert.equal(standingOrders(null), null);
});

test("the brief carries each PR, its terminal, the standing orders and the ask-first protocol", () => {
  const ws = mkWs();
  const origin = mkSess(ws.id, { goal: "fix the login redirect" });
  const url = greenRow(ws.id, origin.id, { review_decision: "APPROVED", mergeable: "MERGEABLE" } as any, prUrl("app"));
  const row = sessionPrs.get(url)!;
  const b = shipBrief("Acme", [row], "- after merge: deploy with `make ship`");
  assert.ok(b.includes(url));
  assert.ok(b.includes("Add the thing"));
  assert.ok(b.includes("acme/app"));
  assert.ok(b.includes("CI: passing"));
  assert.ok(b.includes(origin.id.slice(0, 8)) && b.includes("fix the login redirect"));
  assert.ok(b.includes("- after merge: deploy with `make ship`"));
  assert.match(b, /--operator --wait 0/);
  assert.match(b, /gh pr merge <url> --squash/);
  assert.match(b, /mc when at "tomorrow 10"/);
  assert.match(b, /mc outcome/);
  assert.match(b, /never merge, push, deploy/);
  assert.match(shipBrief("Acme", [row], null), /no "Standing orders" section/);
  assert.equal(shipGoal([row, { ...row, url: url.replace(/\d+$/, "9") }]), `Ship ready PRs: acme/app#${url.split("/").pop()}, #9`);
});

// ──────────────────────────── the pass ────────────────────────────

test("an ended terminal's green PR opens ONE Ship terminal, and is offered once", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id, { goal: "add export" });
  sessions.end(origin.id);
  const a = greenRow(ws.id, origin.id);
  const b = greenRow(ws.id, origin.id, { ci_state: null, no_ci: 1 } as any);
  const calls = fresh();
  const liveIds = new Set<string>();
  const out = await shipPass(Date.now(), deps(calls, { liveIds, enabled: only(ws.id) }));
  assert.equal(calls.opened.length, 1);
  assert.equal(calls.opened[0].created_by, SHIP_BY);
  assert.match(calls.opened[0].goal, /^Ship ready PRs: /);
  assert.ok(calls.opened[0].description.includes(a) && calls.opened[0].description.includes(b));
  assert.deepEqual(out.offered.sort(), [a, b].sort());
  assert.equal(sessionPrs.get(a)?.ship_session_id, out.opened[0]);
  assert.ok(sessionPrs.get(b)?.ship_offered_at);

  const again = await shipPass(Date.now(), deps(calls, { liveIds, enabled: only(ws.id) }));
  assert.deepEqual(again.offered, [], "offered once");
  assert.equal(calls.opened.length, 1);
});

test("a live Ship terminal: typed into when idle, left alone when working or waiting on his answer", async () => {
  const ws = mkWs();
  const ship = mkSess(ws.id, { created_by: SHIP_BY, goal: "Ship ready PRs: acme/repo#1" });
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  const liveIds = new Set([ship.id]);
  const now = Date.now();

  const calls = fresh();
  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [ship.id]: st("working", now) } }));
  assert.equal(calls.sent.length + calls.opened.length, 0, "working → next pass");
  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [ship.id]: st("your_turn", now) }, openAsks: () => 1 }));
  assert.equal(calls.sent.length + calls.opened.length, 0, "his question is open → do not type over it");
  assert.equal(sessionPrs.get(url)?.ship_offered_at, null);

  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [ship.id]: st("your_turn", now) } }));
  assert.equal(calls.opened.length, 0, "never a second Ship terminal");
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0][0], ship.id);
  assert.ok(calls.sent[0][1].includes(url));
  assert.equal(sessionPrs.get(url)?.ship_session_id, ship.id);
});

test("a live originating terminal keeps its PR until it has sat stopped 2h", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  const url = greenRow(ws.id, origin.id);
  const liveIds = new Set([origin.id]);
  const now = Date.now();
  const calls = fresh();
  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [origin.id]: st("your_turn", now - HOUR) } }));
  assert.equal(calls.opened.length, 0);
  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [origin.id]: st("your_turn", now - 3 * HOUR) }, owns: () => true }));
  assert.equal(calls.opened.length, 0, "the operator typed into it");
  await shipPass(now, deps(calls, { liveIds, enabled: only(ws.id), statuses: { [origin.id]: st("your_turn", now - 3 * HOUR) } }));
  assert.equal(calls.opened.length, 1);
  assert.ok(sessionPrs.get(url)?.ship_offered_at);
});

test("skipped while another live terminal already has the PR in hand", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  const num = url.split("/").pop();
  const byHand = mkSess(ws.id, { goal: `merge + deploy PR #${num}` });
  const liveIds = new Set([byHand.id]);
  const calls = fresh();
  await shipPass(Date.now(), deps(calls, { liveIds, enabled: only(ws.id) }));
  assert.equal(calls.opened.length, 0);
  assert.equal(sessionPrs.get(url)?.ship_offered_at, null);

  // Named in another terminal's feed instead of its goal.
  const ws2 = mkWs();
  const o2 = mkSess(ws2.id);
  sessions.end(o2.id);
  const url2 = greenRow(ws2.id, o2.id);
  const reader = mkSess(ws2.id, { goal: "look around" });
  const live = sessions.list({ workspace_id: ws2.id, status: "live" });
  assert.equal(heldElsewhere(sessionPrs.get(url2)!, live, (id) => (id === reader.id ? [{ seq: 1, kind: "say", text: `CI is green on ${url2}` }] : [])), true);
  assert.equal(heldElsewhere(sessionPrs.get(url2)!, live, () => []), false);

  // Once that terminal closes, it is offered.
  sessions.end(byHand.id);
  liveIds.delete(byHand.id);
  await shipPass(Date.now(), deps(calls, { liveIds, enabled: only(ws.id) }));
  assert.equal(calls.opened.length, 1);
});

test("caps: ≤5 PRs per terminal, one new Ship terminal per workspace per pass, ≤4 per hour in all", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const urls = Array.from({ length: 7 }, () => greenRow(ws.id, origin.id));
  const calls = fresh();
  const out = await shipPass(Date.now(), deps(calls, { liveIds: new Set(), enabled: only(ws.id) }));
  assert.equal(calls.opened.length, 1);
  assert.equal(out.offered.length, 5);
  assert.equal(urls.filter((u) => !sessionPrs.get(u)?.ship_offered_at).length, 2, "the rest wait");

  resetShipLoop();
  const many = Array.from({ length: MAX_NEW_PER_HOUR + 2 }, () => {
    const w = mkWs();
    const o = mkSess(w.id);
    sessions.end(o.id);
    greenRow(w.id, o.id);
    return w;
  });
  const calls2 = fresh();
  const now = Date.now();
  await shipPass(now, deps(calls2, { liveIds: new Set(), enabled: (id) => many.some((w) => w.id === id) }));
  assert.equal(calls2.opened.length, MAX_NEW_PER_HOUR);
  await shipPass(now + 10 * 60_000, deps(calls2, { liveIds: new Set(), enabled: (id) => many.some((w) => w.id === id) }));
  assert.equal(calls2.opened.length, MAX_NEW_PER_HOUR, "still inside the hour");
  await shipPass(now + HOUR + 1, deps(calls2, { liveIds: new Set(), enabled: (id) => many.some((w) => w.id === id) }));
  assert.equal(calls2.opened.length, MAX_NEW_PER_HOUR + 2);
});

test("a seat-cap refusal leaves the rows un-offered and warns once", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  let tries = 0;
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    const refuse = { opener: (async () => { tries++; throw new Error("workspace session cap reached (6/6)"); }) as any, enabled: (id: string) => id === ws.id };
    await shipPass(Date.now(), deps(fresh(), refuse));
    await shipPass(Date.now(), deps(fresh(), refuse));
  } finally {
    console.warn = warn;
  }
  assert.equal(tries, 2, "retried next pass");
  assert.equal(sessionPrs.get(url)?.ship_offered_at, null);
  assert.equal(warned.filter((w) => w.includes("[ship]")).length, 1);
});

test("robert.ship_loop off: nothing opens or is typed, rows stay tracked; on by default", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  const mine = (c: Calls) => c.opened.filter((o) => o.workspace_id === ws.id).length;
  // The real setting, read the way the pass reads it — scoped to this workspace so rows left by
  // earlier tests do not spend the hourly cap.
  const realSetting = (id: string) => id === ws.id && settingOn("robert.ship_loop", id);
  writeSetting("robert.ship_loop", false, ws.id);
  try {
    const calls = fresh();
    await shipPass(Date.now(), deps(calls, { enabled: realSetting }));
    assert.equal(mine(calls), 0);
    assert.equal(sessionPrs.get(url)?.state, "open");
    assert.equal(sessionPrs.get(url)?.ship_offered_at, null);
  } finally {
    writeSetting("robert.ship_loop", null, ws.id);
  }
  const calls = fresh();
  await shipPass(Date.now(), deps(calls, { enabled: realSetting }));
  assert.equal(mine(calls), 1);
});

test("allowed() false: the workspace is skipped before opening or typing; rows stay un-offered", async () => {
  const ws = mkWs();
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  const asked: string[] = [];
  const calls = fresh();
  await shipPass(Date.now(), deps(calls, { enabled: only(ws.id), allowed: (id) => (asked.push(id), false) }));
  assert.deepEqual(asked, [ws.id]);
  assert.equal(calls.opened.length, 0);
  assert.equal(sessionPrs.get(url)?.ship_offered_at, null, "a recovered week offers it then");
});

test("the real gate: Ship terminals ignored this week → none opened or typed; engaged enough → back on", async () => {
  const ws = mkWs();
  // Eight earlier Ship terminals, all ended without him typing a key: 0/8 decided.
  const past = Array.from({ length: 8 }, () => {
    const s = mkSess(ws.id, { created_by: SHIP_BY });
    sessions.end(s.id);
    return s.id;
  });
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  const url = greenRow(ws.id, origin.id);
  const calls = fresh();
  await shipPass(Date.now(), deps(calls, { enabled: only(ws.id) }));
  assert.equal(calls.opened.length, 0, "backed off: no new Ship terminal");

  // A live idle Ship terminal is not typed into either.
  const ship = mkSess(ws.id, { created_by: SHIP_BY, goal: "Ship ready PRs: acme/repo#1" });
  const now = Date.now();
  await shipPass(now, deps(calls, { enabled: only(ws.id), statuses: { [ship.id]: st("your_turn", now - HOUR) } }));
  assert.equal(calls.sent.length, 0, "backed off: nothing typed");
  assert.equal(sessionPrs.get(url)?.ship_offered_at, null);

  // He answered three of them after all: 3/8 = 37.5% ≥ 30% → offers resume.
  db.prepare("UPDATE sessions SET operator_inputs=2 WHERE id IN (?,?,?)").run(past[0], past[1], past[2]);
  await shipPass(now, deps(calls, { enabled: only(ws.id), statuses: { [ship.id]: st("your_turn", now - HOUR) } }));
  assert.equal(calls.sent.length, 1);
  assert.equal(calls.sent[0][0], ship.id);
  assert.ok(sessionPrs.get(url)?.ship_offered_at);
});

test("auto-merge workspaces are never offered — they merge their own", async () => {
  const ws = mkWs(true);
  const origin = mkSess(ws.id);
  sessions.end(origin.id);
  greenRow(ws.id, origin.id);
  const calls = fresh();
  await shipPass(Date.now(), deps(calls, { enabled: (id) => id === ws.id }));
  assert.equal(calls.opened.length, 0);
});

test("a Ship terminal's ask always routes to the operator (api.ts POST /asks)", () => {
  const api = fs.readFileSync(path.join(import.meta.dirname, "api.ts"), "utf8");
  assert.match(api, /const route = isShipTerminal\(sess\)\s*\?\s*"operator"/);
});

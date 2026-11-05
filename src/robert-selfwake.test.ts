/**
 * Robert's self-wake: a quiet workspace costs no model turn unless a fact changed, the hour and the
 * cadence gate it, and the one move it allows — opening a terminal — is capped by the daemon.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { db, kv, sessionPrs, sessions, workspaces } from "./store.js";
import { rewriteBrief, BRIEF_SEED } from "./briefs.js";
import { writeSetting } from "./settings.js";
import { quietSweep, wakeSection, SWEEP_KEY } from "./wake-queue.js";
import {
  changed, capRefusal, inHours, issueTicket, localHour, openProactive, PROACTIVE_BY, redeemTicket, selfwakeOnce, selfwakeSay,
  setSelfwakeProbe, signals, SELFWAKE_KEY,
} from "./robert-selfwake.js";
import { sweepOnce, setSweepProbe } from "./robert-sweep.js";
import { isInboxAuto } from "./inbox-guard.js";
import type { TermStatus } from "./term-status.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-05T15:00:00Z");
const st = (phase: TermStatus["phase"], over: Partial<TermStatus> = {}): TermStatus => ({
  phase, line: "", word: phase, needs_you: false, since: NOW, on: null, eta_at: null,
  subagents: 0, progress: null, hooked: true, ...over,
});
let screens = new Map<string, TermStatus>();
setSelfwakeProbe((id) => screens.get(id) ?? null);
setSweepProbe((id) => screens.get(id) ?? null);

let n = 0;
function ws() {
  const w = workspaces.create({ slug: "wake" + ++n, name: "Wake " + n, config_dir: "/tmp/wake" + n });
  writeSetting("robert.proactive_hours", "0-0", w.id); // always inside hours: tests do not depend on the clock
  return w;
}
const term = (wsId: string, over: Record<string, unknown> = {}) =>
  sessions.create({ workspace_id: wsId, goal: "ship the export", cwd: "/tmp", ...over } as any);
const wakes = () => db.prepare("SELECT * FROM robert_wakes WHERE key LIKE ?").all(`${SELFWAKE_KEY}%`) as any[];
function reset() {
  for (const t of ["robert_wakes", "session_prs", "sessions", "notes", "workspaces"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM kv WHERE key LIKE 'selfwake.%'").run();
  screens = new Map();
}
/** A workspace that has been used recently (not dormant), with nothing running. */
function quietWs() {
  const w = ws();
  const s = term(w.id);
  // Real clock, not NOW: sweepOnce reads Date.now(), and a fixed date would make this workspace dormant next week.
  db.prepare("UPDATE sessions SET status='ended', created_at=? WHERE id=?").run(new Date(Date.now() - HOUR).toISOString(), s.id);
  return w;
}

test("inHours: a start-end window in local hours, wrapping past midnight; junk or equal ends = always", () => {
  assert.equal(inHours("09-21", 9), true);
  assert.equal(inHours("09-21", 21), false);
  assert.equal(inHours("22-06", 23), true);
  assert.equal(inHours("22-06", 5), true);
  assert.equal(inHours("22-06", 12), false);
  assert.equal(inHours("0-0", 3), true);
  assert.equal(inHours("whenever", 3), true);
  assert.equal(localHour(Date.parse("2026-11-05T15:00:00Z"), "America/Buenos_Aires"), 12);
});

test("signals: PRs with CI, terminals left waiting 2h+, Next items — stable and sorted", () => {
  reset();
  const w = quietWs();
  const s = term(w.id);
  sessionPrs.record({ url: "https://github.com/acme/app/pull/7", session_id: s.id, workspace_id: w.id, cwd: "/tmp" });
  sessionPrs.update("https://github.com/acme/app/pull/7", { ci_state: "failing" });
  sessionPrs.record({ url: "https://github.com/acme/app/pull/8", session_id: s.id, workspace_id: w.id, cwd: "/tmp" });
  sessionPrs.update("https://github.com/acme/app/pull/8", { ci_state: "passing" });
  const waiting = term(w.id, { goal: "fix the tray export" });
  screens.set(waiting.id, st("your_turn", { since: NOW - 3 * HOUR }));
  const fresh = term(w.id);
  screens.set(fresh.id, st("your_turn", { since: NOW - 10 * 60_000 }));
  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] chase the vendor for the API key\n- [x] old done thing\n"));
  const sig = signals(w, NOW);
  assert.ok(sig.includes("pr https://github.com/acme/app/pull/7 CI failing"));
  assert.ok(!sig.some((l) => l.includes("/pull/8")), "a green PR is the ship loop's, not news");
  assert.ok(sig.some((l) => l.startsWith(`waiting ${waiting.id.slice(0, 8)} your_turn: fix the tray export`)));
  assert.ok(!sig.some((l) => l.includes(fresh.id.slice(0, 8))), "ten minutes is not left waiting");
  assert.ok(sig.includes("next: chase the vendor for the API key"));
  assert.ok(!sig.some((l) => l.includes("old done thing")), "ticked items are not news");
  assert.deepEqual(signals(w, NOW), sig, "same facts, same lines");
});

test("changed: only lines that are new — something resolving is not a reason to wake", () => {
  assert.deepEqual(changed(["a", "b"], ["b", "c"]), ["c"]);
  assert.deepEqual(changed(["a", "b"], ["a"]), []);
});

test("selfwakeOnce: first look with facts wakes him; the same facts again cost no turn", () => {
  reset();
  const w = quietWs();
  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] chase the vendor for the API key\n"));
  assert.equal(selfwakeOnce(w, NOW), null);
  assert.equal(wakes().length, 1);
  const say = JSON.parse(wakes()[0].payload).say;
  assert.match(say, /SELF-WAKE · Wake \d+/);
  assert.match(say, /next: chase the vendor/);
  assert.match(say, /\/api\/robert\/proactive/);

  db.prepare("DELETE FROM robert_wakes").run();
  assert.equal(selfwakeOnce(w, NOW + 31 * 60_000), "nothing new");
  assert.equal(wakes().length, 0, "no model turn when nothing changed");

  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] chase the vendor for the API key\n- [ ] rotate the key\n"));
  assert.equal(selfwakeOnce(w, NOW + 62 * 60_000), null);
  assert.match(JSON.parse(wakes()[0].payload).say, /next: rotate the key/);
  assert.doesNotMatch(JSON.parse(wakes()[0].payload).say, /- next: chase the vendor/, "only what is new is listed");
});

test("selfwakeOnce gates: cadence, hours, setting, dormant workspace, proactive cap", () => {
  reset();
  const w = quietWs();
  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] one thing\n"));
  kv.set(`selfwake.at.${w.id}`, String(NOW - 10 * 60_000));
  assert.equal(selfwakeOnce(w, NOW), "not due");
  kv.set(`selfwake.at.${w.id}`, "0");

  writeSetting("robert.proactive_hours", "01-02", w.id);
  const outside = inHours("01-02", localHour(NOW)) ? null : "outside hours";
  if (outside) assert.equal(selfwakeOnce(w, NOW), "outside hours");
  writeSetting("robert.proactive_hours", "0-0", w.id);

  writeSetting("robert.proactive", false, w.id);
  assert.equal(selfwakeOnce(w, NOW), "off");
  writeSetting("robert.proactive", true, w.id);

  term(w.id, { created_by: PROACTIVE_BY });
  assert.equal(selfwakeOnce(w, NOW + 60_000), "capped", "a proactive terminal this hour: no look at all");
  db.prepare("DELETE FROM sessions WHERE created_by = ?").run(PROACTIVE_BY);

  const old = ws();
  const s = term(old.id);
  db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(NOW - 9 * 24 * HOUR).toISOString(), s.id);
  assert.equal(selfwakeOnce(old, NOW), "dormant");
  assert.equal(wakes().length, 0);
});

test("sweepOnce: a workspace with nothing working gets the self-wake look, independent of the presence-sweep switch", () => {
  reset();
  const w = quietWs();
  writeSetting("robert.sweep", false, w.id);
  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] one thing\n"));
  sweepOnce(5);
  assert.equal(wakes().length, 1);
});

test("a self-wake is a sweep to the queue: its QUIET is acked silently and its own rules are not contradicted", () => {
  assert.ok(SELFWAKE_KEY.startsWith(SWEEP_KEY));
  assert.equal(quietSweep([{ key: `${SELFWAKE_KEY}x` }], "QUIET"), true);
  const say = selfwakeSay({ id: "w1", name: "Acme" }, ["next: a"], 3);
  const shown = wakeSection({ id: "1", key: `${SELFWAKE_KEY}w1`, topic: "robert.selfwake", payload: JSON.stringify({ say }), hits: 1 } as any);
  assert.match(shown, /reply exactly QUIET/);
  assert.doesNotMatch(shown, /Post ONE or TWO lines/);
});

test("openProactive: one terminal per workspace per hour, a daily cap, labelled and boxed", async () => {
  reset();
  const w = quietWs();
  const opened: any[] = [];
  const opener = async (o: any) => { opened.push(o); return term(w.id, { created_by: o.created_by, goal: o.goal }); };
  const r1 = await openProactive({ workspace_id: w.slug, ticket: issueTicket(w.id), goal: "draft the  vendor   follow-up", description: "Next item" }, opener, { nowMs: Date.now() });
  assert.equal(r1.ok, true);
  assert.equal(opened[0].created_by, PROACTIVE_BY);
  assert.equal(opened[0].goal, "draft the vendor follow-up");
  assert.match(opened[0].description, /Robert opened this on his own/);
  assert.ok(isInboxAuto({ created_by: PROACTIVE_BY }), "same box as an inbox terminal: no merge, deploy or messages");

  const r2 = await openProactive({ workspace_id: w.id, ticket: issueTicket(w.id), goal: "another" }, opener, { nowMs: Date.now() });
  assert.deepEqual(r2, { ok: false, status: 429, error: "this workspace already got a proactive terminal in the last hour" });
  assert.equal(opened.length, 1);

  const gated = ws();
  const r3 = await openProactive({ workspace_id: gated.id, ticket: issueTicket(gated.id), goal: "x y z" }, opener, { nowMs: Date.now(), allowed: () => false });
  assert.equal(r3.ok, false);
  assert.equal((r3 as any).status, 429);

  writeSetting("robert.proactive", false, gated.id);
  assert.equal(((await openProactive({ workspace_id: gated.id, ticket: issueTicket(gated.id), goal: "x y z" }, opener)) as any).status, 409);
  assert.equal(((await openProactive({ workspace_id: "nope", goal: "x y z" }, opener)) as any).status, 404);
});

test("capRefusal: the daily cap counts proactive terminals across every workspace", () => {
  reset();
  const prev = process.env.CHRONOS_PROACTIVE_PER_DAY;
  process.env.CHRONOS_PROACTIVE_PER_DAY = "2";
  try {
    const a = ws(), b = ws(), c = ws();
    for (const w of [a, b]) {
      const s = term(w.id, { created_by: PROACTIVE_BY });
      db.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(NOW - 3 * HOUR).toISOString(), s.id);
    }
    assert.match(capRefusal(c.id, NOW) ?? "", /daily cap/);
  } finally {
    if (prev === undefined) delete process.env.CHRONOS_PROACTIVE_PER_DAY; else process.env.CHRONOS_PROACTIVE_PER_DAY = prev;
  }
});

test("sweepOnce: at most one self-wake per pass across workspaces — the post-deploy burst is spread out", () => {
  reset();
  const a = quietWs(), b = quietWs();
  for (const w of [a, b]) rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] one thing\n"));
  sweepOnce(5);
  assert.equal(wakes().length, 1, "one this pass");
  sweepOnce(5);
  assert.equal(wakes().length, 2, "the other one next pass; the first is not due again yet");
});

test("selfwakeOnce: a workspace whose proactive terminals he keeps ignoring gets no look (proactive-score backs it off)", () => {
  reset();
  const w = quietWs();
  rewriteBrief(w.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] one thing\n"));
  for (let i = 0; i < 8; i++) {
    const s = term(w.id, { created_by: PROACTIVE_BY });
    db.prepare("UPDATE sessions SET status='ended', created_at=? WHERE id=?").run(new Date(NOW - 2 * 24 * HOUR).toISOString(), s.id);
  }
  assert.equal(selfwakeOnce(w, NOW), "backed off");
  assert.equal(wakes().length, 0);
  writeSetting("robert.proactive_autotune", false, w.id);
  assert.equal(selfwakeOnce(w, NOW), null, "autotune off: he looks again");
});

test("the wall: a self-wake ticket opens a terminal only in the workspace it was issued for, once", async () => {
  reset();
  const a = quietWs(), b = quietWs();
  const opened: any[] = [];
  const opener = async (o: any) => { opened.push(o); return term(o.workspace_id, { created_by: o.created_by }); };
  const forA = issueTicket(a.id);
  const cross = await openProactive({ workspace_id: b.id, ticket: forA, goal: "leak a's context into b" }, opener);
  assert.deepEqual(cross, { ok: false, status: 403, error: "no valid self-wake ticket for this workspace" });
  assert.equal(redeemTicket(forA), null, "a refused ticket is spent too");
  const none = await openProactive({ workspace_id: a.id, goal: "no ticket at all" }, opener);
  assert.equal((none as any).status, 403);
  const t = issueTicket(a.id);
  assert.equal((await openProactive({ workspace_id: a.id, ticket: t, goal: "the real one" }, opener)).ok, true);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].workspace_id, a.id);
  const old = issueTicket(a.id, Date.now() - 3 * HOUR);
  assert.equal(redeemTicket(old), null, "expired");
  // The wake's prompt carries a ticket for its own workspace.
  rewriteBrief(b.id, BRIEF_SEED.replace("## Next\n", "## Next\n- [ ] one thing\n"));
  assert.equal(selfwakeOnce(b, NOW), null);
  const say = JSON.parse(wakes().at(-1).payload).say as string;
  const tk = /"ticket":"([a-f0-9]{16})"/.exec(say)?.[1];
  assert.ok(tk);
  assert.equal(redeemTicket(tk, NOW), b.id, "redeemed on the same clock the wake was issued on");
});

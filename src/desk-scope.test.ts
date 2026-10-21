/**
 * The client lock: one client on the whole Desk while the screen is shared.
 *
 * Three halves, for the three places it lives:
 *   · the lens (static/desk-scope.js) — run in a vm, the way src/desk-quick-actions.test.ts runs
 *     its mirror, against the shapes the daemon really returns. This is the part that decides what
 *     a client on a call can read, so every surface's payload has a case;
 *   · the wiring (static/desk.html) — read as text, because nothing else would notice a regression
 *     in a page with no build step: the lens has to sit on `api()` and on the bus, not on a surface;
 *   · the readers (src/widgets) — a card is drawn by a module the page does not own, so the daemon
 *     scopes it and says that it did.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { sessions, workspaces } from "./store.js";
import { WIDGETS, readWidget } from "./widgets/index.js";

const store = new Map<string, string>();
const ctx: any = {
  window: {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  },
};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-scope.js"), "utf8"), ctx);
const DS = ctx.window.DeskScope;
// Values cross a vm realm boundary: round-trip through JSON before comparing.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const lens = (p: string, d: unknown) => plain(DS.lens(p, d, LOCK));

const A = "ws-acme", B = "ws-bolt";
const LOCK = { id: A, name: "Acme", slug: "acme", dir: ".claude-acme", i: 2 };
const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");

test("the lock is remembered as the workspace row it was taken from, and null forgets it", () => {
  assert.equal(DS.get(), null);
  DS.set({ id: A, name: "Acme", slug: "acme", config_dir: "/Users/x/.claude-acme" }, 2);
  assert.deepEqual(plain(DS.get()), LOCK);
  DS.set(null);
  assert.equal(DS.get(), null);
  // Storage that holds something else is "not locked", never a throw at boot.
  store.set(DS.KEY, "{not json");
  assert.equal(DS.get(), null);
  store.set(DS.KEY, JSON.stringify({ name: "no id" }));
  assert.equal(DS.get(), null);
  store.clear();
});

test("unlocked, the lens hands back the very same object", () => {
  const d = { sessions: [{ id: "s", workspace_id: B }] };
  assert.equal(DS.lens("/desk", d, null), d);
});

test("it never mutates what the daemon sent", () => {
  const d = { sessions: [{ id: "1", workspace_id: A }, { id: "2", workspace_id: B }] };
  const before = JSON.stringify(d);
  DS.lens("/desk", d, LOCK);
  assert.equal(JSON.stringify(d), before);
});

test("/desk: one client's workspaces, terminals, notes, launches and inbox count", () => {
  const d = lens("/desk", {
    workspaces: [
      { id: A, slug: "acme", name: "Acme", repos: [{ id: "r1", name: "app" }], shared_repos: [{ id: "r9", name: "lib", owner_name: "Bolt", owner_slug: "bolt" }] },
      { id: B, slug: "bolt", name: "Bolt", repos: [], shared_repos: [] },
    ],
    backends: [{ name: "claude-code" }],
    sessions: [{ id: "1", workspace_id: A }, { id: "2", workspace_id: B }, { id: "3", workspace_id: null }],
    jots: [{ id: "j1", workspace_id: A }, { id: "j2", workspace_id: B }],
    launches: [{ id: "l1", workspace_id: B }],
    inbox: { [A]: 2, [B]: 7 },
  });
  assert.deepEqual(d.workspaces.map((w: any) => w.id), [A]);
  assert.deepEqual(d.sessions.map((s: any) => s.id), ["1"], "a terminal with no client is a stranger too");
  assert.deepEqual(d.jots.map((j: any) => j.id), ["j1"]);
  assert.deepEqual(d.launches, []);
  assert.deepEqual(d.inbox, { [A]: 2 });
  assert.deepEqual(d.backends, [{ name: "claude-code" }]);
  // A repo shared INTO this client would have named the client it came from.
  assert.equal(d.workspaces[0].shared_repos[0].owner_name, DS.MASK);
  assert.equal(d.workspaces[0].shared_repos[0].owner_slug, DS.MASK);
  assert.doesNotMatch(JSON.stringify(d), /Bolt|bolt/);
});

test("lists across clients are strict; a read addressed to one thing keeps its unlabelled sub-rows", () => {
  const rows = [{ id: "1", workspace_id: A }, { id: "2", workspace_id: B }, { id: "3", workspace_id: null }];
  for (const p of ["/sessions?status=ended&limit=100", "/asks?status=open", "/briefs", "/jobs/runs?kind=all&days=7", "/somewhere/new"])
    assert.deepEqual(lens(p, rows).map((r: any) => r.id), ["1"], p);
  for (const p of ["/runs?job_id=j1", "/sessions/abc/watch?limit=30", "/notes?workspace=" + A, "/jobs/j1"])
    assert.deepEqual(lens(p, rows).map((r: any) => r.id), ["1", "3"], p);
});

test("Robert's thread: only the rows his Robert for this client wrote", () => {
  const d = lens("/agent/history?ws=all&limit=40", {
    messages: [{ id: 1, workspace_id: A, you: "a" }, { id: 2, workspace_id: B, you: "b" }, { id: 3, workspace_id: null, you: "fleet" }],
  });
  assert.deepEqual(d.messages.map((m: any) => m.id), [1]);
});

test("inbox, jobs and the log: the rows AND the numbers that were added up across clients", () => {
  const ib = lens("/inbox", { items: [{ id: "i1", workspace_id: A }, { id: "i2", workspace_id: B }], counts: { [A]: 1, [B]: 4 } });
  assert.deepEqual(ib.items.map((i: any) => i.id), ["i1"]);
  assert.deepEqual(ib.counts, { [A]: 1 });

  const day = (n: number) => [{ day: "2026-10-13", success: n, failed: 0, other: 0, cost: n }];
  const jb = lens("/jobs/board?kind=all&days=7", {
    jobs: [{ id: "j1", workspace_id: A }, { id: "j2", workspace_id: B }, { id: "sys", workspace_id: null }],
    days: day(9), days_by_ws: { [A]: day(2), [B]: day(7) },
  });
  assert.deepEqual(jb.jobs.map((j: any) => j.id), ["j1"]);
  assert.deepEqual(jb.days, day(2), "the all-clients strip becomes this client's");
  assert.deepEqual(Object.keys(jb.days_by_ws), [A]);

  const lg = lens("/desk/log?since=today", {
    terminals: [
      { id: "1", workspace_id: A, workspace: "Acme", minutes: 10, turns: 3, cost_usd: 1.5, lines_added: 4, lines_removed: 1, blocked_count: 1 },
      { id: "2", workspace_id: B, workspace: "Bolt", minutes: 90, turns: 30, cost_usd: 20, lines_added: 400, lines_removed: 100, blocked_count: 5 },
    ],
    totals: { terminals: 2, minutes: 100, turns: 33, cost_usd: 21.5, lines_added: 404, lines_removed: 101, blocked: 6 },
  });
  assert.deepEqual(lg.totals, { terminals: 1, minutes: 10, turns: 3, cost_usd: 1.5, lines_added: 4, lines_removed: 1, blocked: 1 });
});

test("the cockpit: this client's PRs, and no shop-wide spend", () => {
  const d = lens("/desk/cockpit", { prs: [{ url: "a", workspace_id: A }, { url: "b", workspace_id: B }], spend: { today_usd: 40 } });
  assert.deepEqual(d.prs.map((p: any) => p.url), ["a"]);
  assert.equal(d.spend, null);
});

test("usage: a Claude meter is a profile, and a profile is a client", () => {
  const meters = [
    { cli: "claude", scope: ".claude-acme" }, { cli: "claude", scope: ".claude-bolt" }, { cli: "claude", scope: ".claude" },
    { cli: "grok", scope: "grok" }, { cli: "cursor", scope: "cursor" },
  ];
  assert.deepEqual(lens("/usage", { warnPct: 80, meters }).meters.map((m: any) => m.scope), [".claude-acme", "grok", "cursor"]);
  // A lock that never learned its profile shows no Claude meter rather than all of them.
  const blind = plain(DS.lens("/usage", { meters }, { ...LOCK, dir: "" }));
  assert.deepEqual(blind.meters.map((m: any) => m.cli), ["grok", "cursor"]);
});

test("computers: the clients a Mac may run are cut down, and what the page PATCHes back is not", () => {
  const host = {
    id: "h1", name: "studio", policy: { deny: ["bolt", "acme"] },
    checklist: {
      workspaces: [{ id: A, slug: "acme", name: "Acme", repos: [] }, { id: B, slug: "bolt", name: "Bolt", repos: [] }],
      gh: [{ user: "bolt-bot" }], veto: ["bolt", "acme"], profiles: [{ name: ".claude-acme", ok: true }],
    },
  };
  const d = lens("/hosts", { hosts: [host], listen_urls: ["x"] });
  assert.deepEqual(d.hosts[0].checklist.workspaces.map((w: any) => w.id), [A]);
  assert.deepEqual(d.hosts[0].checklist.gh, []);
  assert.deepEqual(d.hosts[0].checklist.veto, ["acme"]);
  // policy.deny is written back whole by the client switch: lensed, saving Acme's would drop Bolt's.
  assert.deepEqual(d.hosts[0].policy.deny, ["bolt", "acme"]);
  // The PATCH answer is one host, not the list — same cut.
  const one = lens("/hosts/h1", host);
  assert.deepEqual(one.checklist.workspaces.map((w: any) => w.id), [A]);
  assert.deepEqual(one.checklist.gh, []);
  assert.deepEqual(one.policy.deny, ["bolt", "acme"]);
});

test("settings and the Mac chip: workspace lists, share chips and slot holders", () => {
  const st = lens("/settings", { workspace_id: null, workspaces: [{ id: A, name: "Acme" }, { id: B, name: "Bolt" }], settings: [{ key: "k", value: true }] });
  assert.deepEqual(st.workspaces.map((w: any) => w.id), [A]);
  assert.equal(st.settings.length, 1);
  const w = lens("/workspaces/" + A, { id: A, repos: [{ id: "r1", shared_with: [B] }], shared_repos: [{ id: "r2", owner_name: "Bolt" }] });
  assert.deepEqual(w.repos[0].shared_with, []);
  assert.equal(w.shared_repos[0].owner_name, DS.MASK);
  const m = lens("/machine", {
    heavy: { slots: 2, holders: [{ label: "bolt suite", workspace_id: B }, { label: "acme suite", workspace_id: A }], waiting: 0 },
    procs: { workspaces: [{ workspace_id: A, pids: 3 }, { workspace_id: B, pids: 9 }], owners: [{ id: "o", workspace_id: B }] },
  });
  assert.deepEqual(m.heavy.holders.map((h: any) => h.label), ["acme suite"]);
  assert.deepEqual(m.procs.workspaces.map((x: any) => x.workspace_id), [A]);
  assert.deepEqual(m.procs.owners, []);
});

test("the bus: an event for another client, or for another client's Robert, never reaches a handler", () => {
  const ok = (e: unknown) => DS.passes(e, LOCK);
  assert.equal(DS.passes({ topic: "session.input", workspace_id: B, text: "secret" }, null), true, "unlocked: everything");
  assert.equal(ok({ topic: "session.input", workspace_id: A }), true);
  assert.equal(ok({ topic: "session.input", workspace_id: B, text: "secret" }), false);
  assert.equal(ok({ topic: "run.ended", job_name: "nightly", workspace_id: null }), false);
  assert.equal(ok({ topic: "agent.push", ws: A, reply: "hi" }), true);
  assert.equal(ok({ topic: "agent.push", ws: B, reply: "hi" }), false);
  assert.equal(ok({ topic: "agent.delta", ws: null, text: "fleet" }), false);
  assert.equal(ok({ topic: "agent.asked", you: "hi" }), false, "no ws is not this client's");
  // Session-keyed events carry no workspace: byId() drops the ones the lensed page never loaded.
  assert.equal(ok({ topic: "session.status", session_id: "x" }), true);
  assert.equal(ok({ topic: "agent.state", kind: "session", id: "x" }), true);
  assert.equal(ok({ topic: "host.online" }), true);
});

test("the page: the lens sits on api() and on the bus — not on any one surface", () => {
  assert.match(html, /<script src="\/desk-scope\.js"><\/script>/);
  assert.match(html, /const LOCK = DeskScope\.get\(\);/);
  // Every answer, every method: a PATCH can hand a whole host or settings page back.
  assert.match(html, /\.then\(\(d\) => DeskScope\.lens\(p, d, LOCK\)\);/);
  assert.match(html, /let e; try \{ e = JSON\.parse\(ev\.data\); \} catch \{ return; \}\n\s*if \(!DeskScope\.passes\(e, LOCK\)\) return;/);
  // The modules the page hands its `api` to are covered by that one line.
  assert.match(html, /AskCard\.init\(\{ api, /);
  assert.match(html, /DeskCockpit\.init\(\{\n\s*el: qs\("#cockpit"\), api, /);
  assert.match(html, /window\.DeskWidgets = \{ S, api, /);
});

test("the switcher is in the Mac menu bar — never a picker or a badge inside the shared window", () => {
  for (const gone of [/id="lock"/, /lockchip/, /id="menu-lock"/, /id="btn-lock"/, /🔒/]) assert.doesNotMatch(html, gone);
  // The menu calls this; every change reloads, so nothing drawn can outlive a lock.
  assert.match(html, /window\.deskLock = async \(id\) => \{/);
  assert.match(html, /DeskScope\.set\(w, i\);\n\s*location\.reload\(\);/);
  // Every workspace's name goes around the lens and straight to the menu bar — a raw fetch, not api().
  assert.match(html, /const lockList = \(\) => fetch\("\/api\/workspaces", /);
  assert.match(html, /bridge\(\)\.postMessage\(\{ type: "workspaces", list: all\.map\(\(w\) => \(\{ id: w\.id, name: w\.name \}\)\), lock: LOCK \? LOCK\.id : null \}\)/);
  // Altitude is a different page with every client on it.
  assert.match(html, /if \(LOCK\) qs\("#lnk-altitude"\)\.hidden = true;/);
  assert.match(html, /\.menu \[hidden\] \{ display:none; \}/);

  const swift = fs.readFileSync(path.join(process.cwd(), "desktop/app.swift"), "utf8");
  assert.match(swift, /let wsMenu = NSMenu\(title: "Workspace"\)/);
  assert.match(swift, /add\("All Workspaces", id: nil, on: lock == nil\)/);
  assert.match(swift, /case "workspaces":\n\s*workspaceMenu\.fill\(/);
  assert.match(swift, /web\.evaluateJavaScript\("window\.deskLock && window\.deskLock\(\\\(arg\)\); void 0;"\)/);
});

test("the page: locked, Robert is this client's and his own memory stays shut", () => {
  assert.match(html, /if \(LOCK\) \{ body\.ws = LOCK\.id; body\.route = false; \}/);
  assert.match(html, /OV\.sticky = LOCK \? LOCK\.id : sticky\?\.sticky\?\.ws \?\? null;/);
  assert.match(html, /Promise\.all\(\[api\("\/briefs"\), LOCK \? null : api\("\/agents\/robert\/memory"\)\]\)/);
  assert.match(html, /\(LOCK \? "" : `<button data-tab="robert"/);
});

test("the page: a one-client view never overwrites what was saved for all of them", () => {
  assert.match(html, /if \(LOCK\) return render\(\);\n\s*\/\/ A row you removed from Recent must stay removed/);
  assert.match(html, /if \(!LOCK\) localStorage\.setItem\("jobs-ws", J\.ws\);/);
  assert.match(html, /if \(!LOCK\) localStorage\.setItem\("mc-plan-ws"/);
  assert.match(html, /if \(!LOCK\) localStorage\.setItem\("mc-start-off"/);
});

test("widgets: the card asks for one client and is not drawn unless the reader says it complied", async () => {
  assert.match(html, /const q = \[w\.q, LOCK \? "ws=" \+ encodeURIComponent\(LOCK\.id\) : ""\]\.filter\(Boolean\)\.join\("&"\);/);
  assert.match(html, /if \(LOCK && r\.ws !== LOCK\.id\) \{ w\.body\.innerHTML = `<div class="werr">hidden while the Desk shows one client<\/div>`; return; \}/);
  // Every card on the board holds itself to `q.ws` — one that does not is blank on a shared screen.
  assert.deepEqual(WIDGETS.filter((w) => !w.scoped).map((w) => w.name), []);
  for (const w of WIDGETS) {
    assert.equal((await readWidget(w.name, { ws: "ws-nobody" }))?.ws, "ws-nobody", w.name);
    assert.equal((await readWidget(w.name))?.ws, null, w.name);
  }
});

test("widgets: held to a client, the readers answer for that client's terminals alone", async () => {
  const a = workspaces.create({ slug: "lock-acme", name: "Acme", config_dir: "/tmp/acme" });
  const b = workspaces.create({ slug: "lock-bolt", name: "Bolt", config_dir: "/tmp/bolt" });
  const sa = sessions.create({ workspace_id: a.id, cwd: "/tmp", backend: "claude-code", goal: "acme goal" } as any);
  const sb = sessions.create({ workspace_id: b.id, cwd: "/tmp", backend: "claude-code", goal: "bolt goal" } as any);
  const read = async (name: string, ws?: string) => (await readWidget(name, ws ? { ws } : {}))!.data as any;

  // Unheld, the board is the whole shop — the lock must not change what an unlocked Desk reads.
  assert.deepEqual((await read("pulse")).rows.map((r: any) => r.id).sort(), [sa.id, sb.id].sort());

  assert.deepEqual((await read("pulse", a.id)).rows.map((r: any) => r.id), [sa.id]);
  for (const name of ["pulse", "shipped"])
    assert.doesNotMatch(JSON.stringify(await read(name, a.id)), /bolt/i, name);
});

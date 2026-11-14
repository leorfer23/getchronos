/**
 * The visual critic (src/visual-critic.ts) over real ledger rows, through the verifier's real pass
 * (src/request-verifier.ts): hand-offs filed the way the daemon files them, `mc artifact` pages on disk,
 * and the world's edges stubbed — the shared browser (render), the judge (critic), the second reader and
 * the terminal. What is asserted is behaviour: what gets rendered, what the judge is told and shown, what
 * check lands, what is typed back, and what never crosses from one workspace to another.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "critic-test-"));
process.env.CHRONOS_ARTIFACTS = path.join(tmp, "artifacts");
process.env.CHRONOS_OUTCOMES = path.join(tmp, "outcomes");
process.env.CHRONOS_CRITIC_DIR = path.join(tmp, "critic");

const { artifacts, db, jobs, kv, sessions, workspaces } = await import("./store.js");
const { isReadOnlyRun } = await import("./runner.js");
const { sanitizeCwd } = await import("./spawn-guard.js");
const { requests } = await import("./store/requests.js");
const L = await import("./ledger.js");
const V = await import("./request-verifier.js");
const C = await import("./visual-critic.js");
const { artifactFile } = await import("./artifacts.js");
const { saveShot } = await import("./session-outcome.js");
const { saveStyleGuide, RUBRIC } = await import("./house-style.js");
const { writeSetting, _resetSettingsCache } = await import("./settings.js");
type Outcome = import("./types.js").Outcome;
type Session = import("./types.js").Session;
type RenderSource = import("./visual-capture.js").RenderSource;
type Rendered = import("./visual-capture.js").Rendered;

L.setLedgerPhaseProvider(() => ({ phase: "your_turn", line: null }));
L.setLedgerProgressProvider(() => null);
V.setVerifierDelay(0);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const shots = (): Rendered => ({ shots: [{ viewport: "desktop", part: 1, parts: 1, png: PNG }, { viewport: "phone", part: 1, parts: 2, png: PNG }, { viewport: "phone", part: 2, parts: 2, png: PNG }], blocked: null, error: null, notes: ["phone: the page is 520 px wide at a 390 px screen — it scrolls sideways"] });

type Seen = { renders: RenderSource[][]; prompts: string[]; cwds: string[]; told: Array<{ sid: string; text: string }>; verdict: string };
let w: Seen;
beforeEach(() => {
  db.exec("DELETE FROM request_verifications; DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM asks; DELETE FROM sessions;");
  L.resetLedgerMemory();
  V.resetVerifierMemory();
  kv.set("ledger.since", "2000-01-01T00:00:00.000Z");
  w = { renders: [], prompts: [], cwds: [], told: [], verdict: 'CRITIC {"pass":true,"remove":[],"fixes":[],"notes":["headline first, two charts that each earn their place"]}' };
  V.setVerifierDeps({
    review: async () => ({ text: 'VERDICT {"pass":true,"reasons":["answers it"],"aspects":{"queries":true,"crosscheck":true,"assumptions":true}}', run_id: "run-reader", status: "success" }),
    tell: async (sid, text) => { w.told.push({ sid, text }); return null; },
  });
  C.setCriticDeps({
    render: async (_ws, sources) => {
      w.renders.push(sources);
      return sources.map((s) => ("url" in s && /hex\.example/.test(s.url) ? { shots: [], blocked: "it redirected to a sign-in page (app.hex.example)", error: null, notes: [] } : shots()));
    },
    critic: async (_ws, prompt, o) => { w.prompts.push(prompt); w.cwds.push(o.cwd); return { text: `Looked at every screen.\n${w.verdict}`, run_id: "run-critic", status: "success" }; },
  });
});

function world(kind: "investigation" | "pr" = "investigation", name = "acme") {
  const ws = workspaces.create({ slug: `${name}-${Math.random().toString(36).slice(2, 8)}`, name, config_dir: path.join(tmp, `cfg-${Math.random()}`) } as any);
  const s = sessions.create({ workspace_id: ws.id, cwd: tmp, goal: "explain signups by channel", goal_kind: kind, created_by: "operator", backend: "claude-code", model: "opus" } as any);
  L.onLedgerEvent({ topic: "session.started", session_id: s.id });
  return { ws: workspaces.get(ws.id)!, s: sessions.get(s.id)! };
}
function page(wsId: string, sid: string | null, title: string, html: string) {
  const a = artifacts.create({ workspace_id: wsId, session_id: sid, title });
  fs.mkdirSync(path.dirname(artifactFile(a, 1)), { recursive: true });
  fs.writeFileSync(artifactFile(a, 1), html);
  if (sid) L.onLedgerEvent({ topic: "artifact.created", artifact_id: a.id, session_id: sid, title });
  return a;
}
let tick = 0;
function handOff(s: Session, over: Partial<Outcome> = {}): Outcome {
  const cur = sessions.get(s.id)!;
  const o: Outcome = { summary: "signups by channel", changes: [], proof: [], prs: [], shots: [], ask: "review", shipped: [], at: new Date(Date.now() + 1000 + tick++).toISOString(), ...over };
  sessions.setOutcome(s.id, o, cur.outcome ? [...cur.outcome_prev, cur.outcome] : cur.outcome_prev);
  L.syncSession(s.id);
  return o;
}
const reqOf = (s: Session) => requests.get(requests.primaryAt(s.id)!.request_id)!;
const visualOf = (rid: string) => requests.checks(rid).filter((c) => c.name === "visual").pop();
const reviewItem = (rid: string) => requests.items(rid).find((i) => i.action === "review" && i.status === "open")!;

test("a page and a dashboard are rendered at desktop and phone width and judged against the workspace's own style", async () => {
  const { ws, s } = world();
  saveStyleGuide(ws.id, "# House style\n- ACME-RULE: one teal accent, everything else grey");
  const a = page(ws.id, s.id, "Signups by channel", "<h1>ACME-PAGE signups up 18%</h1>");
  handOff(s, { summary: "Signups dashboard: https://bi.example.com/dashboards/41 and the page" });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(out.status, "done", out.reason ?? "");
  // The eyes: both deliverables, on one lease — the page as the Desk frames it, the dashboard by its link.
  assert.equal(w.renders.length, 1);
  const [html, link] = w.renders[0];
  assert.ok("html" in html && html.html.includes("ACME-PAGE") && html.html.includes("Content-Security-Policy"), "the page is rendered framed, as the Desk shows it");
  assert.deepEqual(link, { url: "https://bi.example.com/dashboards/41" });
  // The judge: the bar, this workspace's page, every render by file name, what was measured.
  const prompt = w.prompts[0];
  assert.ok(prompt.includes(RUBRIC));
  assert.match(prompt, /ACME-RULE/);
  assert.match(prompt, /p1-desktop-1\.png — desktop/);
  assert.match(prompt, /p2-phone-2\.png — phone, screen 2 of 2/);
  assert.match(prompt, /it scrolls sideways/);
  assert.match(prompt, /what the operator asked/i);
  // Stored under this workspace's own directory, where the judge runs.
  const dir = w.cwds[0];
  assert.ok(dir.startsWith(path.join(C.criticRoot(), ws.id) + path.sep), dir);
  assert.ok(fs.existsSync(path.join(dir, "p1-desktop-1.png")) && fs.existsSync(path.join(dir, "p2-phone-1.png")));
  // A pass: the check carries what it looked at, and the item is ready.
  const v = visualOf(r.id)!;
  assert.equal(v.status, "pass");
  assert.match(v.note!, /looked at 6 screens of 2 pages \(desktop \+ phone\)/);
  assert.ok(v.evidence.some((e) => e.ref.startsWith(`/api/workspaces/${ws.id}/critic/`)), "each render is evidence the operator can open");
  assert.equal(L.itemReadiness(requests.get(r.id)!, reviewItem(r.id)).ready, true);
  assert.equal(w.told.length, 0);
  assert.equal(a.workspace_id, ws.id);
});

test("quality over quantity: the critic asks for a chart to be removed, and that goes back to the terminal as a round", async () => {
  const { s } = world();
  page(s.workspace_id!, s.id, "Funnel", "<h1>funnel</h1>");
  w.verdict = 'CRITIC {"pass":false,"remove":["Sessions by browser — repeats the device chart and answers nothing he asked"],"fixes":["Revenue chart: title it with the takeaway, e.g. Revenue up 12% on Q2"],"notes":[]}';
  handOff(s);
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(out.told, true);
  assert.equal(out.ready, false);
  const v = visualOf(r.id)!;
  assert.equal(v.status, "fail");
  assert.match(v.note!, /^\(full list: mc style critique\) remove 1: Sessions by browser/);
  assert.match(v.note!, /fix 1: Revenue chart: title it with the takeaway/);
  assert.match(w.told[0].text, /\[verifier\] Not ready.*round 1 of 2.*visual: \(full list: mc style critique\) remove 1: Sessions by browser/);
  const rd = L.itemReadiness(requests.get(r.id)!, reviewItem(r.id));
  assert.equal(rd.status, "failing");
  assert.deepEqual(rd.failed.map((f) => f.name), ["visual"]);
  // The full verdict is one command away for the terminal.
  const c = C.latestCritique(s.workspace_id!, s.id)!;
  assert.equal(c.status, "fail");
  assert.match(String(c.evidence.find((e) => e.ref === "run:run-critic")?.meta?.remove), /Sessions by browser/);
});

test("the verifier's rounds, not a second loop: the third failing hand-off is not typed in", async () => {
  const { s } = world();
  page(s.workspace_id!, s.id, "Funnel", "<h1>funnel</h1>");
  w.verdict = 'CRITIC {"pass":false,"remove":["the donut"],"fixes":[]}';
  handOff(s);
  const r = reqOf(s);
  assert.equal((await V.verifyRequest(r.id)).told, true);
  handOff(s, { summary: "removed the donut" });
  assert.equal((await V.verifyRequest(r.id)).told, true);
  handOff(s, { summary: "really removed it" });
  const three = await V.verifyRequest(r.id);
  assert.equal(three.told, false);
  assert.equal(w.told.length, 2);
  assert.match(three.reason!, /not ready after 2 rounds: visual:/);
  assert.equal(w.prompts.length, 3, "each new hand-off is looked at again");
  assert.match(w.prompts[2], /really removed it/, "the newest hand-off is the one judged, not an older open item");
  assert.doesNotMatch(w.prompts[2], /removed the donut\n/);
});

test("behind a login with nothing attached: the terminal is asked for screenshots, never failed silently", async () => {
  const { s } = world();
  handOff(s, { summary: "Built the app: https://app.hex.example/acme/app/signups" });
  const r = reqOf(s);
  const out = await V.verifyRequest(r.id);
  assert.equal(w.prompts.length, 0, "nothing to look at — no judge run");
  const v = visualOf(r.id)!;
  assert.equal(v.status, "fail");
  assert.match(v.note!, /could not see https:\/\/app\.hex\.example\/acme\/app\/signups \(it redirected to a sign-in page \(app\.hex\.example\)\) — attach screenshots of it at desktop and phone width/);
  assert.match(w.told[0].text, /--shot dashboard-desktop=a\.png --shot dashboard-phone=b\.png/);
  assert.equal(out.ready, false);
});

test("behind a login with screenshots attached: judged from them, and the check says so", async () => {
  const { s } = world();
  const d = saveShot(s.id, "dashboard-desktop", "png", PNG);
  const p = saveShot(s.id, "dashboard-phone", "png", PNG);
  const before = saveShot(s.id, "before-home-phone", "png", PNG); // a UI pair is not a capture of the deliverable
  assert.ok("name" in d && "name" in p && "name" in before);
  handOff(s, {
    summary: "Built the app: https://app.hex.example/acme/app/signups",
    shots: [{ name: d.name, label: "dashboard-desktop" }, { name: p.name, label: "dashboard-phone" }, { name: before.name, label: "before-home-phone" }],
  });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  const prompt = w.prompts[0];
  assert.match(prompt, /NOT rendered: it redirected to a sign-in page.*judge it from the attached screenshots/);
  assert.match(prompt, /attached-1-dashboard-desktop\.png — "dashboard-desktop"/);
  assert.match(prompt, /attached-2-dashboard-phone\.png/);
  assert.doesNotMatch(prompt, /before-home-phone/);
  assert.ok(fs.existsSync(path.join(w.cwds[0], "attached-1-dashboard-desktop.png")), "copied in: the judge reads its own directory");
  const v = visualOf(r.id)!;
  assert.equal(v.status, "pass");
  assert.match(v.note!, /2 attached screenshots/);
  assert.match(v.note!, /not rendered: https:\/\/app\.hex\.example\/acme\/app\/signups \(it redirected to a sign-in page.*judged from the attached screenshots/);
});

test("the wall: another workspace's page named in a hand-off is never opened, and its style never reaches the judge", async () => {
  const A = world("investigation", "acme");
  const B = world("investigation", "globex");
  saveStyleGuide(A.ws.id, "# House style\n- ACME-RULE: teal");
  saveStyleGuide(B.ws.id, "# House style\n- GLOBEX-SECRET-PALETTE: magenta");
  const theirs = page(B.ws.id, B.s.id, "Globex revenue", "<h1>GLOBEX-CONFIDENTIAL revenue</h1>");
  page(A.ws.id, A.s.id, "Acme signups", "<h1>ACME-PAGE</h1>");
  handOff(A.s, { summary: `Done — see http://localhost:7777/desk#artifact=${theirs.id} and the page` });
  const r = reqOf(A.s);
  await V.verifyRequest(r.id);
  const rendered = JSON.stringify(w.renders);
  assert.doesNotMatch(rendered, /GLOBEX-CONFIDENTIAL/, "B's page is not rendered for A");
  assert.match(rendered, /ACME-PAGE/);
  assert.doesNotMatch(w.prompts[0], /GLOBEX/);
  assert.match(w.prompts[0], /ACME-RULE/);
  assert.match(visualOf(r.id)!.note!, /a page of another workspace — not opened/);
  // Renders live under A's directory only; nothing was written under B's.
  assert.ok(!fs.existsSync(path.join(C.criticRoot(), B.ws.id)));
  // And the operating system wall: A's critic directory is denied to B's agents, and B's to A's.
  assert.ok(workspaces.isolationDenyDirs(B.ws.id).includes(path.join(C.criticRoot(), A.ws.id)));
  assert.ok(workspaces.isolationDenyDirs(A.ws.id).includes(path.join(C.criticRoot(), B.ws.id)));
  assert.ok(!workspaces.isolationDenyDirs(A.ws.id).includes(path.join(C.criticRoot(), A.ws.id)));
});

test("the critic off for a workspace: no visual check, nothing rendered", async () => {
  const { ws, s } = world();
  writeSetting("verifier.critic", false, ws.id);
  _resetSettingsCache();
  page(ws.id, s.id, "Funnel", "<h1>funnel</h1>");
  handOff(s);
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(visualOf(r.id), undefined);
  assert.equal(w.renders.length, 0);
  assert.equal(L.itemReadiness(requests.get(r.id)!, reviewItem(r.id)).ready, true, "nothing visual judged, nothing missing");
});

test("code work cites links, it does not deliver them: a PR hand-off with a dashboard link is not judged", async () => {
  const { s } = world("pr");
  handOff(s, { summary: "Fixed the retry; see https://grafana.example.com/dashboards/9 and https://github.com/acme/app/issues/3", ask: "review" });
  const r = reqOf(s);
  await V.verifyRequest(r.id);
  assert.equal(w.renders.length, 0);
  assert.equal(visualOf(r.id), undefined);
});

test("selectTargets: an analysis delivers its links; trackers and code hosts are references; attached captures need a visual label", () => {
  const sel = C.selectTargets({
    workspaceId: "ws-a", kind: "investigation", deliverables: [],
    outcome: {
      summary: "Report: https://docs.example.com/report/7 · issue https://github.com/acme/app/issues/3 · ticket https://acme.atlassian.net/browse/ACM-12 · thread https://acme.slack.com/archives/C1/p2",
      changes: [], proof: [], prs: [], ask: "review", shipped: [], at: "2026-11-13T10:00:00.000Z",
      shots: [{ name: "a", label: "report-desktop" }, { name: "b", label: "after-home-phone" }, { name: "c", label: "terminal output" }, { name: "d", label: "chart-revenue" }],
    },
    artifactOf: () => undefined,
  });
  assert.deepEqual(sel.targets.map((t) => (t.kind === "link" ? t.url : t.id)), ["https://docs.example.com/report/7"]);
  assert.deepEqual(sel.attached.map((a) => a.label), ["report-desktop", "chart-revenue"]);
});

test("parseCritique: the last CRITIC line wins; no verdict is null, never a pass", () => {
  assert.equal(C.parseCritique("I looked. Nothing to say."), null);
  assert.equal(C.parseCritique(null), null);
  const c = C.parseCritique('CRITIC {"pass":true}\nthinking again…\nCRITIC {"pass":false,"remove":["pie"],"fixes":"title it"}')!;
  assert.deepEqual(c, { pass: false, remove: ["pie"], fixes: ["title it"], notes: [] });
  assert.equal(C.parseCritique('final answer: {"pass": true, "notes": ["ok"]}')!.pass, true);
});

test("the judge is a read-only run in the workspace's own critic directory — never $HOME, never another workspace's", async () => {
  const ws = workspaces.create({ slug: `judge-${Math.random().toString(36).slice(2, 8)}`, name: "judge", config_dir: path.join(tmp, "cfg-judge"), sandbox_mode: "off" } as any);
  const other = workspaces.create({ slug: `other-${Math.random().toString(36).slice(2, 8)}`, name: "other", config_dir: path.join(tmp, "cfg-other") } as any);
  const dir = C.passDir(ws.id, "feedface-0000-0000-0000-000000000000", "2026-11-13T10:00:00.000Z");
  fs.mkdirSync(dir, { recursive: true });
  const theirs = C.passDir(other.id, "feedface-0000-0000-0000-000000000000", "2026-11-13T10:00:00.000Z");
  fs.mkdirSync(theirs, { recursive: true });
  assert.equal(sanitizeCwd(dir, ws.id), fs.realpathSync(dir), "its own critic directory is a place its jobs may run");
  assert.equal(sanitizeCwd(theirs, ws.id), null, "another workspace's is not");
  const keepAlive = setInterval(() => {}, 1000);
  const out = await C.defaultCriticDeps.critic(workspaces.get(ws.id)!, "look at the renders", { cwd: dir, backend: "mock", model: "", requestId: "feedface-0000" }).finally(() => clearInterval(keepAlive));
  const job = jobs.list().find((j) => j.workspace_id === ws.id && j.name.startsWith("review:critic-"))!;
  assert.ok(job, "a judge job was dispatched");
  assert.ok(isReadOnlyRun(job.name), "review: is a read-only run (runner.ts READONLY_RUN_PREFIXES)");
  assert.equal(job.cwd, fs.realpathSync(dir), "it runs where the renders are, not in $HOME");
  assert.match(job.disallowed_tools!, /\bEdit\b.*\bWrite\b.*\bBash\b/);
  assert.doesNotMatch(job.disallowed_tools!, /\bRead\b/, "it must be able to Read the PNGs");
  assert.equal(out.status, "success");
});

test("renders are kept per workspace and bounded: the oldest passes go, another workspace's are untouched", () => {
  const a = `prune-a-${Math.random().toString(36).slice(2, 8)}`;
  const b = `prune-b-${Math.random().toString(36).slice(2, 8)}`;
  const mk = (ws: string, i: number) => {
    const d = path.join(C.criticRoot(), ws, `abcdef12-2026111310${String(i).padStart(4, "0")}`);
    fs.mkdirSync(d, { recursive: true });
    const t = new Date(Date.UTC(2026, 10, 1) + i * 60_000);
    fs.utimesSync(d, t, t);
    return d;
  };
  const dirs = Array.from({ length: 45 }, (_, i) => mk(a, i));
  const theirs = mk(b, 0);
  assert.equal(C.prunePasses(a, 40), 5);
  assert.ok(dirs.slice(0, 5).every((d) => !fs.existsSync(d)), "the five oldest are gone");
  assert.ok(dirs.slice(5).every((d) => fs.existsSync(d)));
  assert.ok(fs.existsSync(theirs));
  assert.equal(C.prunePasses(`nobody-${a}`), 0);
});

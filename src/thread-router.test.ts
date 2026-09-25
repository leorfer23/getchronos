import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, chat, kv, repos, sessions, tickets, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { askLine, clearSticky, explainRoute, getSticky, rememberRoute, routeMessage, setSticky } from "./thread-router.js";

let atlas: any, cedar: any;

beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM tickets; DELETE FROM repos; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv;");
  CONFIG.thread.aliases = { at: "atlas", cd: "cedar" };
  CONFIG.thread.stickyMinutes = 90;
  atlas = workspaces.create({ slug: "atlas", name: "Atlas", config_dir: "/tmp/atlas" });
  cedar = workspaces.create({ slug: "cedar", name: "Cedar", config_dir: "/tmp/cedar" });
});

const route = (text: string, ctx: any = {}) => routeMessage(text, { surface: "test", ...ctx });

// A ticket row is enough — the router reads keys, not files.
const mkTicket = (ws: string, key: string, title: string) =>
  db
    .prepare(
      `INSERT INTO tickets (id,workspace_id,key,slug,title,status,priority,assignee,file_path,created_at,updated_at)
       VALUES (?,?,?,?,?,'backlog','P1','agent',?, '2026-01-01','2026-01-01')`,
    )
    .run(key, ws, key, title.replace(/\s+/g, "-"), title, `/tmp/${key}.md`);

// ── a. explicit tag ──────────────────────────────────────────────────────────────────────────────

test("a #slug tag wins and is stripped before the model sees it", () => {
  const r = route("#atlas redeploy the dbt job please");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "tag");
  assert.equal(r.text, "redeploy the dbt job please");
  assert.equal(r.confidence, 1);
});

test("a tag anywhere in the message routes, and an alias tag routes too", () => {
  assert.equal(route("what happened to the loader #cedar ?").ws, cedar.id);
  assert.equal(route("#at status of the warehouse").ws, atlas.id);
  assert.equal(route("#cd the dag is red").how, "tag");
});

test("#all / #fleet / #shop mean fleet-wide", () => {
  for (const tag of ["#all", "#fleet", "#shop"]) {
    const r = route(`${tag} what is running`);
    assert.equal(r.ws, null, tag);
    assert.equal(r.how, "tag", tag);
    assert.equal(r.text, "what is running");
  }
});

test("an unknown #hashtag is left in the text and routes nothing", () => {
  const r = route("#bug the exporter dies on empty input");
  assert.equal(r.how, "ask");
  assert.match(r.text, /#bug/);
});

test("a tag beats a contradicting name in the same message", () => {
  const r = route("#atlas compare this with cedar's loader");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "tag");
});

test("two different tags in one turn are ambiguous, not first-wins", () => {
  const r = route("#atlas #cedar which of the two is further along?");
  assert.equal(r.how, "ask");
  assert.deepEqual(r.candidates.map((c) => c.slug), ["atlas", "cedar", "all"]);
});

// ── b. signals in the text ───────────────────────────────────────────────────────────────────────

test("a ticket key routes to its ticket's workspace", () => {
  mkTicket(atlas.id, "ATL-7", "fix the loader");
  const r = route("ATL-7 is blocked on the credentials");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "key");
});

test("an unknown key still routes by its prefix when exactly one workspace owns it", () => {
  const r = route("did CED-4 ever land?");
  assert.equal(r.ws, cedar.id);
  assert.equal(r.how, "key");
});

test("a prefix two workspaces share is ambiguous — keys are global per prefix", () => {
  const atlantis = workspaces.create({ slug: "atlantis", name: "Atlantis", config_dir: "/tmp/atlantis" });
  const r = route("what is ATL-12 waiting on?");
  assert.equal(r.how, "ask");
  // The shop is always on the list: two projects in one sentence is usually a handoff.
  assert.deepEqual(r.candidates.map((c) => c.ws).sort(), [atlas.id, atlantis.id, null].sort());
});

test("a repo name routes to the workspace that owns the repo", () => {
  repos.create({ workspace_id: cedar.id, name: "airflow", path: "/tmp/repos/airflow" });
  const r = route("the airflow dags need a rerun");
  assert.equal(r.ws, cedar.id);
  assert.equal(r.how, "name");
});

test("a repo path routes too", () => {
  repos.create({ workspace_id: atlas.id, name: "shop", path: "/Users/dev/code/storefront-app" });
  assert.equal(route("look at /Users/dev/code/storefront-app/src/app.ts").ws, atlas.id);
});

test("a workspace mentioned by name or alias routes", () => {
  assert.equal(route("en atlas, cómo va el warehouse?").ws, atlas.id);
  assert.equal(route("for Cedar: rerun the morning check").ws, cedar.id);
  assert.equal(route("cd needs the cost report").ws, cedar.id);
});

test("a name only matches whole words", () => {
  const r = route("the intercedarwood report is fine");
  assert.equal(r.how, "ask");
});

test("two workspaces named in one message ask instead of guessing", () => {
  const r = route("move the loader work from atlas to cedar");
  assert.equal(r.how, "ask");
  assert.deepEqual(r.candidates.map((c) => c.slug).sort(), ["all", "atlas", "cedar"]);
});

test("the sticky project beats the terminal on screen — the composer chip must not lie", () => {
  const s = sessions.create({ workspace_id: cedar.id, title: "loader", cwd: "/tmp" } as any);
  setSticky("test", atlas.id);
  // The Desk always has something on its stage; if that decided every untagged message, the sticky
  // the operator can SEE in the composer would never be what actually happens.
  const r = route("and the migration after that?", { stagedSessionId: s.id });
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "sticky");
  // With no pin, the terminal he is looking at is the best thing left.
  clearSticky("test");
  assert.equal(route("and the migration after that?", { stagedSessionId: s.id }).ws, cedar.id);
});

test("a tagged social message is still social — the tag routes it, it does not pin the thread", () => {
  setSticky("test", cedar.id);
  const r = route("#atlas gracias!");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.social, true);
  rememberRoute("test", r);
  assert.equal(getSticky("test")?.ws, cedar.id);
});

test("a staged terminal routes a message that names nothing — but never overrides the text", () => {
  const s = sessions.create({ workspace_id: cedar.id, title: "loader", cwd: "/tmp" } as any);
  assert.equal(route("kill it and start over", { stagedSessionId: s.id }).ws, cedar.id);
  assert.equal(route("kill it and start over", { uiWorkspace: atlas.id }).ws, atlas.id);
  // the text still wins
  assert.equal(route("en atlas, kill it", { uiWorkspace: cedar.id }).ws, atlas.id);
});

// ── c. fleet intents ─────────────────────────────────────────────────────────────────────────────

test("fleet-wide questions with no workspace signal go unscoped", () => {
  for (const q of [
    "status", "what now", "what's running?", "who needs me", "qué pasó anoche",
    "everything ok?", "all projects", "how's the shop", "standup", "cómo va todo",
  ]) {
    const r = route(q);
    assert.equal(r.ws, null, q);
    assert.equal(r.how, "fleet", q);
  }
});

test("a fleet phrase with a workspace signal is NOT fleet-wide", () => {
  const r = route("status of atlas");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "name");
});

// ── d. sticky ────────────────────────────────────────────────────────────────────────────────────

test("sticky: the next bare message lands where the last one did", () => {
  rememberRoute("test", route("#atlas deploy it"));
  const r = route("and the migration after that?");
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "sticky");
});

test("sticky expires after threadStickyMinutes", () => {
  setSticky("test", atlas.id, Date.now() - 91 * 60_000);
  assert.equal(getSticky("test"), null);
  assert.equal(route("and the migration?").how, "ask");
});

test("stickyMinutes = 0 means forever", () => {
  CONFIG.thread.stickyMinutes = 0;
  setSticky("test", atlas.id, Date.now() - 400 * 60_000);
  assert.equal(getSticky("test")?.ws, atlas.id);
});

test("a social message routes by sticky but never moves it", () => {
  setSticky("test", atlas.id);
  const hi = route("gracias!");
  assert.equal(hi.ws, atlas.id);
  assert.equal(hi.social, true);
  rememberRoute("test", { ...hi, ws: cedar.id }); // even a routed-elsewhere social turn
  assert.equal(getSticky("test")?.ws, atlas.id);
});

test("a fleet-wide turn releases the pin", () => {
  setSticky("test", atlas.id);
  rememberRoute("test", route("what's running?"));
  assert.equal(getSticky("test"), null);
});

test("sticky is per surface — Telegram and the Desk pin separately", () => {
  setSticky("telegram", cedar.id);
  assert.equal(routeMessage("and then?", { surface: "telegram" }).ws, cedar.id);
  assert.equal(routeMessage("and then?", { surface: "web" }).how, "ask");
});

test("a deleted workspace is not a sticky", () => {
  setSticky("test", atlas.id);
  db.prepare("DELETE FROM workspaces WHERE id = ?").run(atlas.id);
  assert.equal(getSticky("test"), null);
});

// ── e. ask ───────────────────────────────────────────────────────────────────────────────────────

test("a work request with no signal and no sticky asks, offering every project plus fleet", () => {
  const r = route("push the branch and open the PR");
  assert.equal(r.how, "ask");
  assert.equal(r.ws, null);
  assert.deepEqual(r.candidates.map((c) => c.slug), ["atlas", "cedar", "all"]);
  assert.equal(askLine(r), "Which project is this about?");
});

test("small talk with nothing sticky is harmless on the unscoped manager", () => {
  const r = route("hola");
  assert.equal(r.ws, null);
  assert.equal(r.how, "fleet");
  assert.equal(r.social, true);
});

test("an ask never writes a sticky", () => {
  rememberRoute("test", route("push the branch"));
  assert.equal(getSticky("test"), null);
});

test("clearSticky hands the thread back to the router", () => {
  setSticky("test", atlas.id);
  clearSticky("test");
  assert.equal(route("and then?").how, "ask");
});

// ── debug ────────────────────────────────────────────────────────────────────────────────────────

test("explainRoute shows the decision and everything it weighed", () => {
  setSticky("test", cedar.id);
  const x = explainRoute("en atlas, cómo va?", { surface: "test" });
  assert.equal(x.route.ws, atlas.id);
  assert.equal(x.workspace?.slug, "atlas");
  assert.equal(x.sticky?.slug, "cedar");
  assert.deepEqual(x.signals.map((s) => s.workspaces[0]), ["atlas"]);
  assert.equal(x.stickyMinutes, 90);
});

test("explainRoute names the tags it stripped", () => {
  const x = explainRoute("#at ship it", { surface: "test" });
  assert.deepEqual(x.tags, ["#at"]);
  assert.equal(x.route.text, "ship it");
});

// ── the isolation this exists to protect ─────────────────────────────────────────────────────────

test("routed rows keep each workspace's recap clean — ws A never sees ws B's turns", () => {
  // What the integration does: route, run, store the row under the ROUTED workspace.
  for (const text of ["#atlas the warehouse is slow", "#cedar the dag is red", "what's running?"]) {
    const r = route(text);
    chat.add(r.text, "ok", "web", r.ws);
    rememberRoute("test", r);
  }
  const gal = chat.contextBlock({ workspaceId: atlas.id });
  const med = chat.contextBlock({ workspaceId: cedar.id });
  assert.match(gal, /warehouse is slow/);
  assert.doesNotMatch(gal, /dag is red|what's running/);
  assert.match(med, /dag is red/);
  assert.doesNotMatch(med, /warehouse is slow/);
  // and the unscoped thread holds only the fleet-wide turn
  assert.deepEqual(chat.recent(99, null).map((r) => r.you), ["what's running?"]);
});

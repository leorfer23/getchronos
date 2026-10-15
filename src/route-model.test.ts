import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { parseRouteAnswer, routePrompt, setRouteModel } from "./route-model.js";
import { resolveTurnSmart, routeSmart, setSticky } from "./thread-router.js";

let atlas: any, cedar: any;
let prompts: string[] = [];
const answer = (json: object | string | null) =>
  setRouteModel(async (p) => { prompts.push(p); return json === null ? null : typeof json === "string" ? json : JSON.stringify(json); });

beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM tickets; DELETE FROM repos; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv;");
  CONFIG.thread.aliases = {};
  CONFIG.thread.stickyMinutes = 90;
  atlas = workspaces.create({ slug: "atlas", name: "Atlas", config_dir: "/tmp/atlas" });
  cedar = workspaces.create({ slug: "cedar", name: "Cedar", config_dir: "/tmp/cedar" });
  prompts = [];
});
afterEach(() => setRouteModel(null));

test("an explicit #tag is still a rule: the model is never asked", async () => {
  answer({ project: "cedar", confidence: 0.99, why: "x" });
  const r = await routeSmart("#atlas ship it", { surface: "t" });
  assert.equal(r.ws, atlas.id);
  assert.equal(r.how, "tag");
  assert.equal(prompts.length, 0);
});

test("anything else is the model's call — made with the open terminals and the rules' hints", async () => {
  sessions.create({ workspace_id: cedar.id, cwd: "/tmp", backend: "claude-code", title: "fix the invoice loader", goal: "invoice loader stops duplicating rows" } as any);
  setSticky("t", atlas.id);
  answer({ project: "cedar", confidence: 0.9, why: "the invoice loader terminal is cedar's" });
  const r = await routeSmart("how is the invoice loader going?", { surface: "t" });
  assert.equal(r.ws, cedar.id);
  assert.equal(r.how, "model");
  assert.match(r.why, /^model: /);
  // What it was shown: the projects, the terminal, and the sticky as a hint — not as the answer.
  assert.match(prompts[0], /- cedar: Cedar/);
  assert.match(prompts[0], /cedar · fix the invoice loader/);
  assert.match(prompts[0], /previous message landed on atlas/);
  assert.match(prompts[0], /Message: """how is the invoice loader going\?"""/);
});

test("the rules' signals reach the model as hints", async () => {
  answer({ project: "atlas", confidence: 0.8, why: "named" });
  await routeSmart("what's up with atlas", { surface: "t" });
  assert.match(prompts[0], /named Atlas → atlas/);
});

test("the model can't tell (or is unsure) → ask, its likely picks first", async () => {
  answer({ project: "ask", confidence: 0.2, why: "no topic", candidates: ["cedar"] });
  const t = await resolveTurnSmart("push the branch", { surface: "t" });
  assert.equal(t.how, "ask");
  assert.deepEqual(t.ask!.candidates.map((c) => c.slug), ["cedar", "atlas", "all"]);
  answer({ project: "atlas", confidence: 0.3, why: "guess" });
  assert.equal((await routeSmart("push the branch", { surface: "t" })).how, "ask");
});

test("small talk never gets a question: an unsure model hands it back to the rules", async () => {
  answer({ project: "ask", confidence: 0.1, why: "?" });
  const r = await routeSmart("gracias", { surface: "t" });
  assert.notEqual(r.how, "ask");
  assert.equal(r.social, true);
});

test("no usable answer → the rules, exactly as before", async () => {
  setSticky("t", cedar.id);
  for (const bad of [null, "sure, cedar", '{"project":"nonexistent","confidence":0.9}']) {
    answer(bad);
    const r = await routeSmart("and the migration?", { surface: "t" });
    assert.equal(r.how, "sticky");
    assert.equal(r.ws, cedar.id);
  }
});

test("the whole shop is a route too", async () => {
  answer({ project: "all", confidence: 0.8, why: "spans projects" });
  const r = await routeSmart("compare the two loaders", { surface: "t" });
  assert.equal(r.ws, null);
  assert.equal(r.how, "model");
});

test("a picked project skips routing entirely", async () => {
  answer({ project: "atlas", confidence: 0.9, why: "x" });
  const t = await resolveTurnSmart("ship it", { selected: cedar.id, surface: "t" });
  assert.equal(t.ws, cedar.id);
  assert.equal(prompts.length, 0);
});

test("parseRouteAnswer: JSON inside chatter, # stripped, confidence clamped", () => {
  const r = parseRouteAnswer('Sure: {"project":"#Cedar","confidence":7,"why":"x","candidates":["#atlas"]}');
  assert.equal(r!.ws, cedar.id);
  assert.equal(r!.confidence, 1);
  assert.deepEqual(r!.candidates, ["atlas"]);
  assert.equal(parseRouteAnswer("{not json}"), null);
});

test("routePrompt lists nothing it was not given", () => {
  const p = routePrompt("hi", { signals: [], fleetIntent: false, social: true, sticky: null, staged: null });
  assert.match(p, /Open terminals[^\n]*\n\(none\)/);
  assert.match(p, /small talk/);
});

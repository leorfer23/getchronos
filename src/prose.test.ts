import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { kv, workspaces } from "./store.js";
import { proseSamples } from "./store/prose.js";
import { agentContext } from "./skills.js";
import {
  GUIDE_CAP, GUIDE_SLUG, addSample, harvestComments, learnDue, learnGoal, markPushed, proseBlock, proseBrief, proseGuide, saveGuide,
} from "./prose.js";
import type { ExternalTask } from "./connectors/types.js";

const mkWs = (slug: string) => workspaces.create({ slug: `${slug}-${randomUUID().slice(0, 6)}`, name: slug, config_dir: `/tmp/mc-test/${slug}-${randomUUID()}` });

const task = (id: string, comments: ExternalTask["comments"]): ExternalTask => ({
  id, title: id, url: null, status: "ready", statusRaw: "To Do", updated: null, description: null,
  priority: null, assignee: null, labels: [], due: null, comments,
});

const MINE = "Merged. Deploying tomorrow morning — ping me if the backfill looks off.";

test("a sample lands once per workspace; the same text again is a no-op", () => {
  const w = mkWs("prose-dedupe");
  const a = addSample(w.id, { body: MINE, channel: "slack" }, "operator");
  const b = addSample(w.id, { body: `  ${MINE.replace(" ", "  ")} ` }, "agent");
  assert.ok(a.ok && a.sample && a.sample.channel === "slack" && a.sample.origin === "operator");
  assert.ok(b.ok && b.sample === null, "whitespace-only difference is the same message");
  assert.equal(proseSamples.list(w.id).length, 1);
});

test("acks are too short to learn from; a draft makes it an edit pair", () => {
  const w = mkWs("prose-edit");
  const short = addSample(w.id, { body: "thanks!" }, "operator");
  assert.ok(!short.ok);
  const r = addSample(w.id, { body: MINE, draft: "I hope this finds you well! I wanted to let you know the PR has been merged." }, "agent");
  assert.ok(r.ok && r.sample);
  assert.equal(r.sample.source, "edit");
  assert.match(proseBrief(w.id), /An agent drafted:[\s\S]*He sent instead:[\s\S]*Deploying tomorrow/);
});

test("harvest keeps only the operator's own comments, never what Chronos pushed", () => {
  const w = mkWs("prose-harvest");
  const pushed = "Status: the migration ran clean on staging, prod is next.";
  markPushed(pushed);
  const n = harvestComments(w, "jira", "acc-me", [
    task("ACM-1", [
      { id: "1", author: "Leo", author_id: "acc-me", body: MINE, created: null },
      { id: "2", author: "Leo", author_id: "acc-other", body: "A colleague who also happens to be called Leo.", created: null },
      { id: "3", author: "Leo", author_id: "acc-me", body: pushed, created: null },
      { id: "4", author: "Leo", author_id: "acc-me", body: "Shipped via Chronos: fix the thing\n\nPR: https://x", created: null },
      { id: "5", author: "Leo", author_id: "acc-me", body: "ok", created: null },
    ]),
  ]);
  assert.equal(n, 1);
  const [s] = proseSamples.list(w.id);
  assert.equal(s.origin, "connector");
  assert.equal(s.ref, "jira:ACM-1#1");
  assert.equal(harvestComments(w, "jira", "acc-me", [task("ACM-1", [{ id: "1", author: "Leo", author_id: "acc-me", body: MINE, created: null }])]), 0, "re-pull adds nothing");
  assert.equal(harvestComments(w, "jira", null, [task("ACM-2", [{ author: "Leo", body: MINE + " again", created: null }])]), 0, "no identity → no harvest");
});

test("samples stay inside their workspace", () => {
  const a = mkWs("prose-wall-a");
  const b = mkWs("prose-wall-b");
  addSample(a.id, { body: MINE, channel: "slack" }, "operator");
  assert.equal(proseSamples.list(b.id).length, 0);
  assert.doesNotMatch(proseBrief(b.id), /Deploying tomorrow/);
  assert.equal(proseBlock(b.id), "");
});

test("the guide is capped, and brief puts it first with the closest same-channel samples", () => {
  const w = mkWs("prose-guide");
  assert.ok(!saveGuide(w.id, "x".repeat(GUIDE_CAP + 1)).ok);
  const g = saveGuide(w.id, "# Prose guide\n\n- 1–3 short sentences, no greeting.");
  assert.ok(g.ok && g.note.slug === GUIDE_SLUG && !g.note.context, "a memo, not ★ — agents pull it with mc prose");
  addSample(w.id, { body: "Jira: repro'd on staging, root cause is the stale cache key. Fix in review.", channel: "jira" }, "operator");
  addSample(w.id, { body: MINE, channel: "slack" }, "operator");
  const text = proseBrief(w.id, { channel: "slack", about: "deploy tomorrow", limit: 1 });
  assert.match(text, /in English, always/);
  assert.ok(text.indexOf("no greeting") < text.indexOf("Deploying tomorrow"));
  assert.doesNotMatch(text, /stale cache key/, "limit 1 keeps the closest slack sample only");
  assert.ok(saveGuide(w.id, "# Prose guide\n\n- v2").ok);
  assert.match(proseGuide(w.id)!.body, /v2/, "a relearn replaces the same memo");
});

test("every agent carries the pointer once the workspace has any prose", () => {
  const w = mkWs("prose-pointer");
  assert.doesNotMatch(agentContext(w.id), /mc prose/);
  addSample(w.id, { body: MINE }, "operator");
  assert.match(agentContext(w.id), /mc prose --channel/);
});

test("relearn is due after enough new samples, at most once a day", () => {
  const w = mkWs("prose-due");
  for (let i = 0; i < 9; i++) addSample(w.id, { body: `${MINE} (${i}) and a distinct tail number ${i}` }, "operator");
  assert.equal(learnDue(w), false, "9 < minNew");
  addSample(w.id, { body: `${MINE} one more distinct message` }, "operator");
  assert.equal(learnDue(w), true);
  kv.set(`prose.learned.${w.id}`, new Date().toISOString());
  addSample(w.id, { body: `${MINE} after the pass, eleven` }, "operator");
  assert.equal(learnDue(w), false, "inside the 24h window");
  assert.equal(learnDue(w, Date.now() + 25 * 3600_000), false, "only 1 new since the pass");
});

test("the learner's goal asks for an English guide and names Slack only when connected", () => {
  const w = mkWs("prose-goal");
  assert.match(learnGoal(w, false), /ALWAYS English/);
  assert.doesNotMatch(learnGoal(w, false), /from:me/);
  assert.match(learnGoal(w, true), /from:me/);
});

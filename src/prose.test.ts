import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { kv, lessons, workspaces } from "./store.js";
import { proseSamples } from "./store/prose.js";
import { agentContext } from "./skills.js";
import { decayLessons, publishLesson, recordLesson } from "./lessons.js";
import { updateNote } from "./notes.js";
import { CONFIG } from "./config.js";
import {
  GUIDE_CAP, GUIDE_SLUG, VOICE_HEADING, addSample, harvestComments, learnDue, learnGoal, markPushed, proseBlock, proseBrief, proseGuide, saveGuide,
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

// ── the voice page: one capped page per workspace, built from samples AND his comms corrections ──

const learnedAgo = (wsId: string, ms: number) => kv.set(`prose.learned.${wsId}`, new Date(Date.now() - ms).toISOString());
const HOUR = 3600_000;

test("the voice page is one page: exactly the cap saves, one char more is refused, never trimmed", () => {
  const w = mkWs("voice-cap");
  assert.equal(GUIDE_CAP, 2500);
  assert.ok(saveGuide(w.id, "v".repeat(GUIDE_CAP)).ok);
  const over = saveGuide(w.id, "w".repeat(GUIDE_CAP + 1));
  assert.ok(!over.ok && /capped at 2500/.test(over.error) && /don't append/.test(over.error));
  assert.equal(proseGuide(w.id)!.body, "v".repeat(GUIDE_CAP), "a refused save leaves the old page whole");
});

test("agentContext carries ONE voice section — the page itself — and no separate comms-lessons block", () => {
  const w = mkWs("voice-inject");
  recordLesson({ workspace_id: w.id, rule: "Lead every status report with the dollar number, then the blocker.", topic: "comms" });
  assert.doesNotMatch(agentContext(w.id), /dollar number/, "a comms rule is input to the page, never injected as a row");
  assert.doesNotMatch(agentContext(w.id), /How this operator wants to be talked to/);

  saveGuide(w.id, "# Voice\n\nTo him: cost first, blocker second, 3 lines max.\nAs him: no greeting, lowercase ok.");
  const ctx = agentContext(w.id);
  assert.equal(ctx.split(VOICE_HEADING).length - 1, 1, "exactly one voice section");
  assert.match(ctx, /cost first, blocker second/, "the page body, not just a pointer");
  assert.equal((ctx.match(/mc prose --channel/g) || []).length, 1, "the drafting pointer rides inside the same section");
  assert.doesNotMatch(ctx, /dollar number/);
  assert.equal(lessons.list({ workspace_id: w.id }).length, 1, "the rule is still stored — it is the evidence");

  saveGuide(w.id, "x".repeat(GUIDE_CAP));
  assert.ok(proseBlock(w.id).length <= GUIDE_CAP + VOICE_HEADING.length + 400, "section is the page plus a fixed heading and pointer");
});

test("a page saved before the cap came down is never truncated into the prompt, and is due for a rewrite", () => {
  const w = mkWs("voice-over");
  addSample(w.id, { body: MINE }, "operator");
  saveGuide(w.id, "short");
  updateNote(proseGuide(w.id)!.id, { body: "# Voice\n" + "y".repeat(3590) }); // what medialab's looks like today
  const block = proseBlock(w.id);
  assert.doesNotMatch(block, /yyyy/, "no half-page cut mid-rule");
  assert.match(block, /over its one-page cap/);
  assert.match(block, /mc prose --channel/);
  learnedAgo(w.id, 2 * HOUR);
  assert.equal(learnDue(w), false, "an oversize page waits out the daily window, so a failed condense can't loop");
  learnedAgo(w.id, 25 * HOUR);
  assert.equal(learnDue(w), true);
  assert.match(learnGoal(w, false), /over the 2500 cap — condense it hard/);
});

test("an active comms lesson marks the page dirty; build rules and proposals don't", () => {
  const w = mkWs("voice-dirty");
  addSample(w.id, { body: MINE }, "operator");
  learnedAgo(w.id, 2 * HOUR);
  assert.equal(learnDue(w), false, "1 sample < minNew, nothing else changed");

  recordLesson({ workspace_id: w.id, rule: "Never commit generated files by hand in this repo.", topic: "build" });
  recordLesson({ workspace_id: w.id, rule: "Keep status updates under three sentences for him.", topic: "comms", state: "proposed" });
  assert.equal(learnDue(w), false, "a build rule and an unconfirmed proposal are not his word on voice");

  recordLesson({ workspace_id: w.id, rule: "Answer his question in the first line, context after.", topic: "comms" });
  assert.equal(learnDue(w), true, "a correction outranks the sample threshold");

  learnedAgo(w.id, 10 * 60_000);
  recordLesson({ workspace_id: w.id, rule: "Skip the recap of what he already said to you.", topic: "comms" });
  assert.equal(learnDue(w), false, "a burst of corrections within the hour folds into one rewrite");
  assert.equal(learnDue(w, Date.now() + HOUR), true);
});

test("a comms rule that goes away (delete, or edited out of comms) also leaves the page stale", () => {
  const w = mkWs("voice-gone");
  const l = recordLesson({ workspace_id: w.id, rule: "Put the ticket key first in every message to him.", topic: "comms" });
  kv.set(`prose.dirty.${w.id}`, new Date(Date.now() - 3 * HOUR).toISOString()); // the rule landed…
  learnedAgo(w.id, 2 * HOUR); // …and a pass folded it in after
  assert.equal(learnDue(w), false);
  publishLesson(l, "deleted");
  assert.equal(learnDue(w), true);
});

test("the learner's goal carries his comms corrections — they outrank samples — and works with no samples at all", () => {
  const w = mkWs("voice-goal");
  recordLesson({ workspace_id: w.id, rule: "Always give him the cost in dollars before anything else.", topic: "comms" });
  recordLesson({ workspace_id: w.id, rule: "Never commit generated files by hand in this repo.", topic: "build" });
  const goal = learnGoal(w, false);
  assert.match(goal, /cost in dollars before anything else/);
  assert.doesNotMatch(goal, /generated files/, "only comms rules are voice input");
  assert.match(goal, /OUTRANK/);
  assert.match(goal, /no samples of his writing yet — build the page from his corrections alone/);
  assert.match(goal, /Rewrite the WHOLE page — never append/);
  assert.match(goal, new RegExp(`≤${GUIDE_CAP - 300} chars`));
  assert.equal(learnDue(w), true, "a workspace with corrections but no samples still gets a page");
  addSample(w.id, { body: MINE }, "operator");
  assert.match(learnGoal(w, false), /mc prose samples --json/);
});

test("an active comms rule never decays for idleness — it no longer fires on its own", () => {
  const w = mkWs("voice-decay");
  const l = recordLesson({ workspace_id: w.id, rule: "Give him the number first, then the story behind it.", topic: "comms" });
  decayLessons(Date.parse(l.created_at) + (CONFIG.lessonIdleTtlDays + 1) * 86_400_000);
  assert.equal(lessons.get(l.id)!.state, "active");
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation as agent-memory.test.ts: persona memory lives in the REAL `personal` workspace and
// notes.ts resolves <repo>/notes/... at module load, so point CHRONOS_HOME at a temp dir BEFORE the
// first import or these cases rewrite the operator's own memory files.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-stow-"));

const { db, workspaces, notes: noteStore } = await import("./store.js");
const { CONFIG } = await import("./config.js");
const { rewriteMemory, agentMemoryNote } = await import("./agent-memory.js");
const { recordLesson } = await import("./lessons.js");
const { captureLearnings } = await import("./notes.js");
const { runStowPass, recentReinforcement } = await import("./stow.js");
const { entryHash } = await import("./memory-tiers.js");

const AGENT = "ada";
const at = (d: string) => new Date(`${d}T12:00:00Z`);
const BUDGET = CONFIG.memoryBudgetTokens;

let wsId = "";
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM lessons; DELETE FROM workspaces;");
  wsId = workspaces.create({ slug: "personal", name: "Personal", config_dir: "/tmp/mc-test/personal" }).id;
  CONFIG.memoryBudgetTokens = BUDGET;
  CONFIG.stowPassHorizon = false;
});

const seed = (body: string) => rewriteMemory(AGENT, body);
const memory = () => agentMemoryNote(AGENT, false)!.body;
const archive = () => noteStore.bySlug(wsId, `memory-archive-${AGENT}`)?.body ?? "";

test("no evidence, no reinforcement — the pass never refreshes a date on its own", () => {
  seed("# Memory — ada\n\n## Facts\n- the deploy script rebuilds dist <!--a:2026-08-20-->\n");
  const r = runStowPass(AGENT, { now: at("2026-08-25") });
  assert.deepEqual(r.reinforced, []);
  assert.match(memory(), /<!--a:2026-08-20-->/); // untouched, not restamped to today
  assert.deepEqual(r.archived, []);
});

test("evidence the caller can name reinforces that entry, by text or by hash", () => {
  seed(
    "# Memory — ada\n\n## Facts\n" +
      "- the deploy script rebuilds dist <!--a:2026-08-20/4-->\n" +
      "- the operator hates being asked twice <!--a:2026-08-20-->\n",
  );
  const hash = entryHash("the operator hates being asked twice");
  const r = runStowPass(AGENT, {
    now: at("2026-08-25"),
    reinforced: ["The deploy script rebuilds dist", hash],
  });
  assert.equal(r.reinforced.length, 2);
  // A refreshed date also clears the unreinforced-pass counter; nothing else clears it.
  assert.match(memory(), /rebuilds dist <!--a:2026-08-25-->/);
  assert.match(memory(), /asked twice <!--a:2026-08-25-->/);
});

test("an unmarked legacy entry gets exactly one grace pass, then the cold tier", () => {
  seed("# Memory — ada\n\n## Facts\n- a fact nobody ever stamped\n");
  const first = runStowPass(AGENT, { now: at("2026-08-25") });
  assert.equal(first.graced.length, 1);
  assert.deepEqual(first.archived, []);
  assert.match(memory(), /nobody ever stamped <!--g-->/); // kept, and never stamped with a date

  const second = runStowPass(AGENT, { now: at("2026-08-26") });
  assert.equal(second.archived[0].reason, "legacy-unvalidated");
  assert.doesNotMatch(memory(), /nobody ever stamped/);

  // …unless the next pass can name evidence for it, in which case it rejoins the clock.
  seed("# Memory — ada\n\n## Facts\n- a fact nobody ever stamped <!--g-->\n");
  runStowPass(AGENT, { now: at("2026-08-27"), reinforced: ["a fact nobody ever stamped"] });
  assert.match(memory(), /nobody ever stamped <!--a:2026-08-27-->/);
});

test("a stale entry is archived with full provenance under a dated heading", () => {
  seed(
    "# Memory — ada\n\n## Facts\n" +
      "- the away-daemon owns triage until MC-91 lands <!--p:2026-07-20-->\n" +
      "- pool slots share one repo <!--a:2026-07-01-->\n" +
      "- never restart the daemon while runs are active <!--P-->\n",
  );
  const r = runStowPass(AGENT, { now: at("2026-08-28") });

  assert.deepEqual(r.archived.map((a) => a.reason), ["unreinforced 39d", "unreinforced 58d"]);
  assert.match(archive(), /## 2026-08-28 stow/);
  assert.match(
    archive(),
    /- \(from memory-ada\.md, tier: perishable, reinforced: 2026-07-20\) the away-daemon owns triage until MC-91 lands \[archived: unreinforced 39d\]/,
  );
  assert.match(
    archive(),
    /- \(from memory-ada\.md, tier: aging, reinforced: 2026-07-01\) pool slots share one repo \[archived: unreinforced 58d\]/,
  );
  // Pinned has no clock, and the archive is a move: the memory file keeps only what survived.
  assert.match(memory(), /never restart the daemon/);
  assert.doesNotMatch(memory(), /pool slots/);
});

test("the archive is append-only across passes and is never budget-counted", () => {
  CONFIG.memoryBudgetTokens = 10_000;
  seed("# Memory — ada\n\n## Facts\n- first stale fact <!--a:2026-07-01-->\n- second stale fact <!--a:2026-07-02-->\n");
  runStowPass(AGENT, { now: at("2026-08-28") });
  const afterFirst = archive();
  seed(`${memory()}- third stale fact <!--a:2026-07-03-->\n`);
  const r = runStowPass(AGENT, { now: at("2026-08-29") });

  assert.ok(archive().startsWith(afterFirst.replace(/\n$/, "")), "earlier archive lines were rewritten");
  assert.match(archive(), /third stale fact/);
  assert.deepEqual(
    r.after.files.map((f) => path.basename(f.path)),
    ["memory-ada.md"],
  );
});

test("over budget: archive stale first, then evict aging oldest-reinforced-first", () => {
  seed(
    "# Memory — ada\n\n## Facts\n" +
      "- oldest fact <!--a:2026-08-02-->\n" +
      "- middle fact <!--a:2026-08-10-->\n" +
      "- newest fact <!--a:2026-08-20-->\n",
  );
  // A budget that fits the header plus exactly one entry: two must go, oldest first.
  CONFIG.memoryBudgetTokens = 25;
  const r = runStowPass(AGENT, { now: at("2026-08-25") });

  assert.deepEqual(r.archived.map((a) => a.text.trim()), ["oldest fact", "middle fact"]);
  assert.deepEqual(r.archived.map((a) => a.reason), ["budget oldest-first", "budget oldest-first"]);
  assert.match(archive(), /\[archived: budget oldest-first\]/);
  assert.match(memory(), /newest fact/); // the best-reinforced entry is the one that survives
  assert.equal(r.ok, true);
  assert.equal(r.after.over, 0);
});

test("convergence precondition: when eviction cannot reach the budget it evicts nothing", () => {
  seed(
    "# Memory — ada\n\n## Pinned\n" +
      "- the operator's authority boundaries, at length, pinned and immovable <!--P-->\n" +
      "- a second immovable pinned line the pass may never touch <!--P-->\n" +
      "\n## Facts\n- an aging fact worth keeping <!--a:2026-08-20-->\n",
  );
  CONFIG.memoryBudgetTokens = 20; // below the pinned floor alone
  const r = runStowPass(AGENT, { now: at("2026-08-25") });

  assert.deepEqual(r.archived, [], "destroyed knowledge that could not close the gap");
  assert.match(memory(), /an aging fact worth keeping/);
  assert.equal(r.ok, false);
  assert.match(r.decision!, /over budget by \d+ tokens/);
  assert.match(r.decision!, /immovable/); // names the pinned entries that crowd out the budget
  assert.ok(r.pinnedFloor.tokens > r.after.budget);
  assert.equal(r.pinnedFloor.entries.length, 2);
});

test("a pass that cannot reach the budget never reports success", () => {
  seed("# Memory — ada\n\n## Facts\n- a single unstampable pinned-by-section fact <!--P-->\n");
  CONFIG.memoryBudgetTokens = 5;
  const r = runStowPass(AGENT, { now: at("2026-08-25") });
  assert.equal(r.ok, false);
  assert.ok(r.decision, "an over-budget pass ended silently");
  assert.ok(r.after.over > 0);
});

test("the pass horizon only ticks when the daemon opted in", () => {
  seed("# Memory — ada\n\n## Facts\n- a fact <!--a:2026-08-20-->\n");
  runStowPass(AGENT, { now: at("2026-08-21") });
  assert.match(memory(), /<!--a:2026-08-20-->/); // no counter written at all

  CONFIG.stowPassHorizon = true;
  runStowPass(AGENT, { now: at("2026-08-21") });
  assert.match(memory(), /<!--a:2026-08-20\/1-->/);
  for (let i = 0; i < 9; i++) runStowPass(AGENT, { now: at("2026-08-21") });
  assert.doesNotMatch(memory(), /a fact/);
  assert.match(archive(), /\[archived: unreinforced 10p\]/);
});

test("an absent memory file is absent — the pass writes nothing and reports ok", () => {
  const r = runStowPass("nobody", { now: at("2026-08-25") });
  assert.equal(r.ok, true);
  assert.deepEqual(r.archived, []);
  assert.equal(agentMemoryNote("nobody", false), null);
});

test("unattended evidence comes from lessons and learnings actually written, and nothing else", () => {
  recordLesson({
    workspace_id: wsId,
    repo_id: null,
    scope: null,
    topic: "build",
    rule: "Deploy with npm run deploy; launchd runs dist.",
    source: "operator",
    source_ref: null,
    state: "active",
  });
  captureLearnings(wsId, ["The pool slots share one repo."], "session");

  const evidence = recentReinforcement(new Date());
  assert.ok(evidence.has(entryHash("deploy with npm run deploy; launchd runs dist.")));
  assert.ok(evidence.has(entryHash("the pool slots share one repo.")));
  assert.equal(evidence.has(entryHash("a fact nobody wrote down anywhere")), false);

  // Old evidence is not evidence: a week-old learning no longer renews an entry's lease.
  const later = new Date(Date.now() + 30 * 86_400_000);
  assert.equal(recentReinforcement(later).size, 0);
});

test("an unattended pass never retires a graced legacy entry; an attended one does", () => {
  seed("# Memory — ada\n\n## Facts\n- legacy fact nobody has quoted back\n");
  const first = runStowPass(AGENT, { now: at("2026-09-14"), resolveGrace: false });
  assert.equal(first.graced.length, 1);
  const second = runStowPass(AGENT, { now: at("2026-09-21"), resolveGrace: false });
  assert.equal(second.archived.length, 0, "unattended: kept");
  assert.equal(second.awaitingValidation.length, 1);
  assert.match(memory(), /legacy fact nobody has quoted back <!--g-->/);
  const third = runStowPass(AGENT, { now: at("2026-09-28") });
  assert.equal(third.archived.length, 1, "attended with no evidence: retired to the archive");
  assert.equal(third.archived[0].reason, "legacy-unvalidated");
});

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same isolation as agent-memory.test.ts: notes resolve <repo>/notes/<ws>/<slug>.md at module load,
// and a brief is a real note in a real workspace — point CHRONOS_HOME at a temp dir before importing.
process.env.CHRONOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mc-briefs-"));

const { db, workspaces } = await import("./store.js");
const { BRIEF_SEED, BRIEF_SLUG, appendBrief, briefNote, briefStamp, briefsBlock, listBriefs, rewriteBrief } = await import("./briefs.js");

let acme = "", globex = "";
beforeEach(() => {
  db.exec("DELETE FROM notes; DELETE FROM workspaces;");
  acme = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/mc-test/acme" }).id;
  globex = workspaces.create({ slug: "globex", name: "Globex", config_dir: "/tmp/mc-test/globex" }).id;
});

test("a brief is one note per workspace, seeded with the sections, created on first write", () => {
  assert.equal(briefNote(acme, false), null);
  const n = appendBrief(acme, "Abby signs off every PR", "How work is done here");
  assert.equal(n.slug, BRIEF_SLUG);
  assert.equal(n.workspace_id, acme);
  assert.match(n.body, /## What the operator wants \(goals\)/);
  assert.match(n.body, /## How work is done here\nAbby signs off every PR/);
  assert.match(n.file_path, /mc-briefs-/);
});

test("the prompt block carries only written briefs — a seed page is not an understanding", () => {
  assert.equal(briefsBlock(null), "");
  rewriteBrief(globex, BRIEF_SEED);
  assert.equal(briefsBlock(null), "", "an untouched seed says nothing");
  rewriteBrief(acme, "# Robert — brief\n\n## What the operator wants (goals)\nShip the menu report by Friday\n");
  const all = briefsBlock(null);
  assert.match(all, /YOUR STANDING UNDERSTANDING/);
  assert.match(all, /### Acme \(workspace /);
  assert.match(all, /Ship the menu report by Friday/);
  assert.doesNotMatch(all, /Globex/);
  // Scoped to a workspace: that page only.
  assert.doesNotMatch(briefsBlock(globex), /Acme/);
  assert.match(briefsBlock(acme), /Acme/);
});

test("the stamp moves on every write, so a warm Robert recycles at the next turn", () => {
  const before = briefStamp();
  appendBrief(acme, "2026-09-11 · shipped the tray blanking export", "Recently");
  assert.notEqual(briefStamp(), before);
  assert.equal(listBriefs().filter((b) => b.note).length, 1);
});

// ───────────────────────── a brief Robert can act on ─────────────────────────

const { normalizeBrief, capNext, briefPromptBody, STANDING_TEMPLATE } = await import("./briefs.js");

test("a repeated heading is folded into the first one, not stapled on again", () => {
  rewriteBrief(acme, BRIEF_SEED);
  appendBrief(acme, "Abby signs off every PR", "How work is done here");
  appendBrief(acme, "Deploys go through staging first", "how work is done here");
  appendBrief(acme, "2026-11-04 · the export · shipped", "Recently");
  appendBrief(acme, "chase the vendor for the API key", "Next");
  const b = briefNote(acme, false)!.body;
  assert.equal(b.match(/^## How work is done here$/gm)?.length, 1);
  assert.equal(b.match(/^## Recently$/gm)?.length, 1);
  assert.equal(b.match(/^## Next$/gm)?.length, 1);
  assert.match(b, /## How work is done here\nAbby signs off every PR\nDeploys go through staging first/);
  assert.match(b, /## Recently\n- 2026-11-04 · the export · shipped/);
  assert.match(b, /## Next\n- \[ \] chase the vendor for the API key/);
});

test("a page that already collected duplicates heals on its next write, newest line kept", () => {
  const dupes = Array.from({ length: 30 }, (_, i) => `\n## Recently\n- 2026-10-${String(i + 1).padStart(2, "0")} · old ${i} · done\n`).join("");
  const sick = `# Robert — brief\n\n## Recently\n- 2026-09-01 · first · done\n\n## Next\n- [ ] one\n${dupes}\n## Next\n- [ ] two\n`;
  const healed = normalizeBrief(sick);
  assert.equal(healed.match(/^## Recently$/gm)?.length, 1);
  assert.equal(healed.match(/^## Next$/gm)?.length, 1);
  assert.match(healed, /## Next\n- \[ \] one\n- \[ \] two/);
  assert.equal(healed.match(/^- \d{4}-/gm)?.length, 12, "Recently back under its cap");
  assert.equal(normalizeBrief(healed), healed, "idempotent");
  // The worklog's own write must not lose its new line to the folding.
  rewriteBrief(acme, BRIEF_SEED);
  const fresh = briefNote(acme, false)!;
  db.prepare("UPDATE notes SET body = ? WHERE id = ?").run(sick, fresh.id);
  appendBrief(acme, "2026-11-05 · today's work · shipped", "Recently");
  assert.match(briefNote(acme, false)!.body, /2026-11-05 · today's work · shipped/);
});

test("Next is a queue, not an archive: newest open items and the last few ticked survive", () => {
  const items = [
    ...Array.from({ length: 40 }, (_, i) => `- [ ] item ${i}`),
    ...Array.from({ length: 8 }, (_, i) => `- [x] done ${i}`),
  ];
  const kept = capNext(items, 25);
  assert.equal(kept.filter((l) => l.startsWith("- [ ]")).length, 25);
  assert.equal(kept[0], "- [ ] item 15", "the oldest open items rolled off");
  assert.deepEqual(kept.filter((l) => l.startsWith("- [x]")), ["- [x] done 3", "- [x] done 4", "- [x] done 5", "- [x] done 6", "- [x] done 7"]);
});

test("Standing orders: added where missing, empty labels never reach the prompt, filled ones lead it", () => {
  const old = `# Robert — brief\n\n## What this is\nA menu app\n\n## How work is done here\nPRs to main\n\n## Recently\n- 2026-11-01 · x · done\n`;
  const n = normalizeBrief(old);
  assert.match(n, /## How work is done here\nPRs to main\n\n## Standing orders\n- Ship:/);
  assert.doesNotMatch(briefPromptBody(n, 3000), /Standing orders|- Never:/, "an unfilled template says nothing");

  const filled = n.replace("- Ship:", "- Ship: merge, then npm run deploy").replace("- Never:", "- Never: post in client channels");
  const prompt = briefPromptBody(filled + `\n## Next\n${"- [ ] filler item that is long enough\n".repeat(60)}`, 600);
  assert.ok(prompt.length <= 600);
  assert.match(prompt, /## Standing orders\n- Ship: merge, then npm run deploy\n- Never: post in client channels/);
  assert.doesNotMatch(prompt, /Robert may do alone:/);
  assert.ok(STANDING_TEMPLATE.length === 5);
});

test("an untouched seed from before Standing orders existed is still a seed", () => {
  const oldSeed = "# Robert — brief\n\n## What this is\n\n## What the operator wants (goals)\n\n## How work is done here\n\n## Recently\n\n## Next\n";
  const n = briefNote(globex)!;
  db.prepare("UPDATE notes SET body = ? WHERE id = ?").run(oldSeed, n.id);
  assert.equal(briefsBlock(null), "");
});

test("unscoped, one long brief no longer crowds the other workspaces out of the prompt", () => {
  rewriteBrief(acme, `# Robert — brief\n\n## What the operator wants (goals)\nAcme goal\n\n## What this is\n${"z".repeat(18000)}\n`);
  rewriteBrief(globex, `# Robert — brief\n\n## What the operator wants (goals)\nGlobex goal\n`);
  const all = briefsBlock(null);
  assert.match(all, /Acme goal/);
  assert.match(all, /Globex goal/);
});

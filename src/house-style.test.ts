/**
 * House style per workspace (src/house-style.ts, src/style-sources.ts): what is found in a workspace's
 * OWN profile and repos, the default page Chronos writes only when there is nothing, what `mc style`
 * and every agent's context carry, what it learns from — and that none of it crosses workspaces.
 * Real store rows (in-memory DB) and real directories under a temp dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { kv, repos, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import { agentContext } from "./skills.js";
import {
  DEFAULT_STYLE, RUBRIC, STYLE_CAP, STYLE_POINTER, STYLE_SLUG, addStyleNote, ensureStyle, newNotes, onStyleDecision, saveStyleGuide, styleBrief,
  styleForCritic, styleGuide, styleLearnDue, styleLearnGoal, styleNotes,
} from "./house-style.js";
import { discoverStyleSources, docSaysStyle, isStyleSkill, registeredSources } from "./style-sources.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "house-style-"));
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const write = (p: string, text: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const skill = (dir: string, name: string, desc: string, body = "## Rules\n- …") => write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`);

function mkWs(name: string, opts: { profile?: boolean } = {}) {
  const cfg = path.join(root, `cfg-${name}-${randomUUID().slice(0, 6)}`);
  if (opts.profile !== false) fs.mkdirSync(cfg, { recursive: true });
  const ws = workspaces.create({ slug: `${name}-${randomUUID().slice(0, 6)}`, name, config_dir: cfg } as any);
  return workspaces.get(ws.id)!;
}
function mkRepo(wsId: string, name: string) {
  const p = path.join(root, `repo-${name}-${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(p, { recursive: true });
  repos.create({ workspace_id: wsId, name, path: p } as any);
  return p;
}

test("is it style guidance: a dataviz or design skill is; a tool that publishes dashboards, a code formatter or a codebase-design skill is not", () => {
  assert.ok(isStyleSkill("dataviz", "Read before any chart: colors, palette, marks"));
  assert.ok(isStyleSkill("artifact-design", "Design guidance and fundamentals for pages"));
  assert.ok(isStyleSkill("brand-guidelines", ""));
  assert.ok(isStyleSkill("acme-reports", "Brand colours, typography and chart styles for client reports"));
  assert.ok(!isStyleSkill("html-publisher", "Publish websites, dashboards and documents to the web"));
  assert.ok(!isStyleSkill("codebase-design", "Shared vocabulary for designing deep modules"));
  assert.ok(!isStyleSkill("graphify", "Knowledge graph over a codebase"));
  assert.ok(!isStyleSkill("pdf", "Extract text and tables from PDF files"));
  assert.ok(docSaysStyle("brand-guidelines.md", null));
  assert.ok(docSaysStyle("dashboards.md", null));
  assert.ok(!docSaysStyle("STYLE.md", "# Code style\nUse prettier, 2 spaces, no semicolons."), "a code style guide is not a house style");
  assert.ok(docSaysStyle("STYLE.md", "# Report style\nOur palette is teal on grey; typography: Inter for titles; every chart..."));
  assert.ok(!docSaysStyle("logo.png", null));
});

test("discovery reads the workspace's OWN profile, plugins and repos — never another workspace's places", () => {
  const A = mkWs("acme");
  const B = mkWs("globex");
  const repoA = mkRepo(A.id, "app");
  const repoB = mkRepo(B.id, "theirs");
  // A's profile: a style skill, a tool, a plugin installed inside the profile.
  skill(path.join(A.config_dir, "skills"), "dataviz", "Read before any chart: palette, colours and marks for visualization");
  skill(path.join(A.config_dir, "skills"), "html-publisher", "Publish dashboards to the web");
  const plug = path.join(A.config_dir, "plugins", "cache", "kit", "brand-kit", "1.0.0");
  skill(path.join(plug, "skills"), "brand-kit", "Brand colours and typography for every page");
  write(path.join(A.config_dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "brand-kit@kit": [{ scope: "user", installPath: plug }] } }));
  // A's repo: a brand guide, a code style guide, a project skill.
  write(path.join(repoA, "docs", "brand-guidelines.md"), "# Acme brand\nTeal accents.");
  write(path.join(repoA, "docs", "STYLE.md"), "# Code style\nprettier, 2 spaces.");
  skill(path.join(repoA, ".claude", "skills"), "chart-rules", "How charts look in our reports: palette, titles, layout");
  // B's places hold style too — and a link from A's profile points into B's repo.
  skill(path.join(B.config_dir, "skills"), "globex-dataviz", "GLOBEX palette and chart colours");
  skill(path.join(repoB, ".claude", "skills"), "globex-brand", "GLOBEX brand colours and typography");
  fs.symlinkSync(path.join(repoB, ".claude", "skills", "globex-brand"), path.join(A.config_dir, "skills", "planted"));
  // …and a plugin A's profile says is installed in B's repo.
  write(path.join(A.config_dir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "brand-kit@kit": [{ scope: "user", installPath: plug }],
    "stolen@x": [{ scope: "user", installPath: path.join(repoB, ".claude") }],
  } }));

  const found = discoverStyleSources(A, { home });
  const names = found.map((s) => s.name).sort();
  assert.deepEqual(names, ["brand-kit:brand-kit", "chart-rules", "dataviz", "docs/brand-guidelines.md"]);
  assert.deepEqual(found.find((s) => s.name === "brand-kit:brand-kit")!.kind, "plugin", "named as the Skill tool reaches it");
  assert.deepEqual(found.find((s) => s.name === "chart-rules")!.where, "repo app");
  assert.ok(found.every((s) => !/globex/i.test(s.name + s.desc + s.path)), "nothing of B's reaches A");
  // B sees only its own.
  assert.deepEqual(discoverStyleSources(B, { home }).map((s) => s.name).sort(), ["globex-brand", "globex-dataviz"]);
});

test("registered once, re-scanned when stale or asked; a workspace with no profile dir registers nothing", () => {
  const A = mkWs("reg");
  skill(path.join(A.config_dir, "skills"), "dataviz", "chart palette and colours");
  const first = registeredSources(A, { deps: { home } });
  assert.deepEqual(first.sources.map((s) => s.name), ["dataviz"]);
  skill(path.join(A.config_dir, "skills"), "brand", "Brand typography");
  assert.deepEqual(registeredSources(A, { deps: { home } }).sources.map((s) => s.name), ["dataviz"], "cached");
  assert.deepEqual(registeredSources(A, { rescan: true, deps: { home } }).sources.map((s) => s.name).sort(), ["brand", "dataviz"]);
  assert.deepEqual(registeredSources(A, { now: Date.now() + 7 * 3600_000, deps: { home } }).sources.length, 2, "stale → scanned again");
  const N = mkWs("noprofile", { profile: false });
  assert.deepEqual(registeredSources(N).sources, []);
});

test("nothing of its own: Chronos writes the default page once; with a style source of its own it writes nothing", () => {
  const bare = mkWs("bare");
  const one = ensureStyle(bare);
  assert.equal(one.created, true);
  assert.equal(styleGuide(bare.id)!.slug, STYLE_SLUG);
  assert.equal(styleGuide(bare.id)!.body, DEFAULT_STYLE);
  assert.ok(DEFAULT_STYLE.length <= STYLE_CAP, "the default fits its own cap");
  assert.equal(ensureStyle(bare).created, false, "once");

  const own = mkWs("own");
  skill(path.join(own.config_dir, "skills"), "dataviz", "Chart palette and colours for visualization");
  const r = ensureStyle(own, { rescan: true });
  assert.equal(r.created, false);
  assert.equal(styleGuide(own.id), undefined);
  assert.deepEqual(r.sources.map((s) => s.name), ["dataviz"]);
});

test("mc style: the bar, what the kind adds, the workspace's own sources first, then its page", () => {
  const own = mkWs("brief");
  skill(path.join(own.config_dir, "skills"), "dataviz", "Chart palette and colours for visualization");
  registeredSources(own, { rescan: true });
  saveStyleGuide(own.id, "# House style\n- BRIEF-RULE: KPI tiles in one row");
  const text = styleBrief(own, { kind: "report" });
  assert.ok(text.includes(RUBRIC));
  assert.match(text, /## A report/);
  assert.doesNotMatch(text, /## A dashboard/);
  assert.match(text, /This workspace's own style — follow it first[\s\S]*skill `dataviz` \(profile\)/);
  assert.match(text, /BRIEF-RULE/);
  assert.match(text, /--shot dashboard-desktop=a\.png/, "it says how to show a page behind a login");
  assert.ok(text.indexOf("dataviz") < text.indexOf("BRIEF-RULE"), "its own sources come before the page");
  assert.match(styleBrief(own, { kind: "nonsense" }), /## A dashboard/, "an unknown kind reads as a dashboard");
});

test("context: every agent gets ONE pointer line; workspace A's style never reaches workspace B's agents", () => {
  const A = mkWs("ctx-a");
  const B = mkWs("ctx-b");
  saveStyleGuide(A.id, "# House style\n- ACME-ONLY-RULE: teal accents");
  skill(path.join(A.config_dir, "skills"), "acme-dataviz", "ACME palette and chart colours");
  registeredSources(A, { rescan: true });
  const ctxA = agentContext(A.id);
  const ctxB = agentContext(B.id);
  assert.equal(ctxA.split(STYLE_POINTER).length - 1, 1, "the pointer, once");
  assert.equal(ctxB.split(STYLE_POINTER).length - 1, 1);
  assert.match(STYLE_POINTER, /mc style --kind dashboard\|report\|artifact/);
  assert.doesNotMatch(ctxA, /ACME-ONLY-RULE/, "the page is behind the command, never inlined");
  for (const text of [ctxB, styleBrief(B, { kind: "dashboard" }), styleForCritic(B).text]) {
    assert.doesNotMatch(text, /ACME-ONLY-RULE|acme-dataviz/i, "nothing of A's in what B's agents and critic read");
  }
  assert.match(styleForCritic(A).text, /ACME-ONLY-RULE/);
  assert.match(styleForCritic(A).text, /ACME palette/, "the critic reads A's own source in its own words");
});

test("one page: a longer page is refused, never trimmed", () => {
  const w = mkWs("cap");
  const r = saveStyleGuide(w.id, "x".repeat(STYLE_CAP + 1));
  assert.ok(!r.ok && /capped at 3000/.test(r.error));
  assert.ok(saveStyleGuide(w.id, "# v1").ok);
  assert.ok(saveStyleGuide(w.id, "# v2").ok);
  assert.equal(styleGuide(w.id)!.body, "# v2", "rewritten whole, the same memo");
});

test("what it learns from: his corrections and his approvals on a visual hand-off, for that workspace only", () => {
  const A = mkWs("learn-a");
  const B = mkWs("learn-b");
  const r = requests.create({ workspace_id: A.id, words: "a dashboard of signups by channel", via: "typed" });
  const page = requests.upsertDeliverable({ request_id: r.id, kind: "artifact", ref: randomUUID(), label: "Signups page" });
  const { item } = requests.upsertItem({ request_id: r.id, action: "review", label: "Signups page", item_key: `review|${page.id}|1`, deliverable_id: page.id });
  requests.decide(item.id, { decision: "change", words: "No pie charts, and put the KPI row first", by: "operator" });
  onStyleDecision({ request_id: r.id, item_id: item.id, workspace_id: A.id, decision: "change" });
  assert.deepEqual(styleNotes(A.id).map((n) => [n.kind, n.origin, n.text]), [["correction", "operator", "No pie charts, and put the KPI row first"]]);
  assert.deepEqual(styleNotes(B.id), []);
  // A forged event naming another workspace is ignored.
  onStyleDecision({ request_id: r.id, item_id: item.id, workspace_id: B.id, decision: "change" });
  assert.deepEqual(styleNotes(B.id), []);
  // A decision on work with nothing visual is not about style.
  const plain = requests.create({ workspace_id: A.id, words: "fix the retry", via: "typed" });
  const pr = requests.upsertDeliverable({ request_id: plain.id, kind: "pr", ref: "https://github.com/acme/app/pull/1" });
  const merge = requests.upsertItem({ request_id: plain.id, action: "merge", label: "PR #1", item_key: `merge|${pr.id}|1`, deliverable_id: pr.id }).item;
  requests.decide(merge.id, { decision: "change", words: "rename the function please", by: "operator" });
  onStyleDecision({ request_id: plain.id, item_id: merge.id, workspace_id: A.id, decision: "change" });
  assert.equal(styleNotes(A.id).length, 1);

  // The rewrite is due on a fresh correction, and its brief carries A's notes only.
  assert.equal(styleLearnDue(A), true);
  assert.equal(styleLearnDue(B), false);
  addStyleNote(B.id, { text: "GLOBEX wants magenta everywhere", origin: "agent" });
  const goal = styleLearnGoal(A);
  assert.match(goal, /No pie charts, and put the KPI row first/);
  assert.doesNotMatch(goal, /GLOBEX/);
  assert.match(goal, /mc style guide --body -/);
  assert.match(goal, /≤2700 chars/);
  kv.set(`style.learned.${A.id}`, new Date(Date.now() + 1000).toISOString());
  assert.deepEqual(newNotes(A.id), [], "nothing new after a pass");
  assert.equal(styleLearnDue(A), false);
});

test("notes: too short, too long and repeats are refused or folded", () => {
  const w = mkWs("notes");
  assert.equal(addStyleNote(w.id, { text: "ok", origin: "agent" }).ok, false);
  assert.equal(addStyleNote(w.id, { text: "y".repeat(900), origin: "agent" }).ok, false);
  const a = addStyleNote(w.id, { text: "Titles must state the takeaway", origin: "agent" });
  const b = addStyleNote(w.id, { text: "titles must state the takeaway", origin: "operator" });
  assert.ok(a.ok && a.note && b.ok && b.note === null);
  assert.equal(styleNotes(w.id).length, 1);
});

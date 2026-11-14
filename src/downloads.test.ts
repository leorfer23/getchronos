/**
 * The operator's Downloads, one folder per workspace (src/downloads.ts): what each folder is called,
 * that no two workspaces ever share one (a shared folder would be granted to both), that a rename
 * never leaves a folder unwalled, and that a headless run is handed its folder.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Before the store loads: every folder this file makes lands here, never in a real ~/Downloads.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dl-store-")));
process.env.CHRONOS_DOWNLOADS_DIR = path.join(root, "Downloads");

const { assignFolders, downloadsRoot, folderName } = await import("./downloads.js");
const { db, events, jobs, kv, runs, workspaces } = await import("./store.js");
const { dispatch } = await import("./dispatcher.js");

let n = 0;
const mkWs = (name: string, slug = `dl${++n}`) =>
  workspaces.create({ slug, name, config_dir: path.join(root, `cfg-${slug}`), sandbox_mode: "off" } as any);
const dl = (f: string) => path.join(root, "Downloads", f);

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM workspaces;");
  kv.del("downloads.folders");
});

test("a workspace name becomes one safe folder name", () => {
  assert.equal(folderName("Acme"), "Acme");
  assert.equal(folderName("Acme / Ops: EU"), "Acme - Ops- EU");
  assert.equal(folderName("../../etc"), "etc", "never a path out of Downloads");
  assert.equal(folderName("  .hidden  "), "hidden");
  assert.equal(folderName("-rf"), "rf");
  assert.equal(folderName("tab\there\nnewline\u0007"), "tab here newline-");
  assert.equal(folderName("Report. "), "Report");
  assert.equal(folderName("x".repeat(200)).length, 80);
  assert.equal(folderName("\u{1F600}".repeat(100)), "\u{1F600}".repeat(30), "whole emoji only, 120 bytes at most");
  assert.equal(folderName("Diseño"), "Diseño", "one Unicode form");
  assert.equal(folderName(".."), "");
  assert.equal(folderName(null), "");
});

test("the root: CHRONOS_DOWNLOADS_DIR wins, a test run gets a temp dir, otherwise ~/Downloads", () => {
  const pick = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dl-root-")));
  assert.equal(downloadsRoot({ CHRONOS_DOWNLOADS_DIR: pick }), pick);
  assert.match(downloadsRoot({ CHRONOS_TEST: "1" }), new RegExp(`chronos-test-downloads-${process.pid}$`));
  assert.ok(downloadsRoot({}).endsWith(`${path.sep}Downloads`));
  assert.ok(!downloadsRoot({ CHRONOS_TEST: "1" }).startsWith(path.join(os.homedir(), "Downloads")), "a test never writes the real Downloads");
});

test("two workspaces never share a folder, whatever the case or Unicode form of their names", () => {
  const rows = [
    { id: "a", slug: "acme", name: "Acme" },
    { id: "b", slug: "acme-eu", name: "ACME" },
    { id: "c", slug: "studio", name: "Diseño" },
    { id: "d", slug: "studio-2", name: "Diseño" },
    { id: "e", slug: "plain", name: "Globex" },
    // APFS folds these into one directory too (checked on a real volume).
    { id: "f", slug: "street", name: "Straße" },
    { id: "g", slug: "street-2", name: "STRASSE" },
    { id: "h", slug: "street-3", name: "STRAẞE" },
  ];
  const f = assignFolders(rows);
  assert.equal(f.get("a"), "Acme", "the older one keeps the plain name");
  assert.equal(f.get("b"), "ACME (acme-eu)");
  assert.equal(f.get("c"), "Diseño");
  assert.equal(f.get("d"), "Diseño (studio-2)");
  assert.equal(f.get("e"), "Globex");
  assert.equal(f.get("f"), "Straße");
  assert.equal(f.get("g"), "STRASSE (street-2)");
  assert.equal(f.get("h"), "STRAẞE (street-3)");
});

test("no name to use: the slug, then the id", () => {
  const f = assignFolders([{ id: "id-1", slug: "acme", name: "///" }, { id: "id-2", slug: "", name: "" }]);
  assert.equal(f.get("id-1"), "acme");
  assert.equal(f.get("id-2"), "id-2");
});

test("a held folder stays its holder's: a rename moves on, a newcomer named like the old one gets another", () => {
  // Acme held "Acme", then was renamed "Acme Corp"; a new workspace is now called "acme".
  const held = { a: ["Acme"] };
  const f = assignFolders([{ id: "a", slug: "acme", name: "Acme Corp" }, { id: "n", slug: "newco", name: "acme" }], held);
  assert.equal(f.get("a"), "Acme Corp");
  assert.equal(f.get("n"), "acme (newco)");
  // A deleted workspace's folder is still nobody else's.
  assert.equal(assignFolders([{ id: "n", slug: "newco", name: "Gone" }], { deleted: ["Gone"] }).get("n"), "Gone (newco)");
  // A newer workspace that already holds a name keeps it from an older one that never had a folder.
  const g = assignFolders([{ id: "old", slug: "old", name: "Shared" }, { id: "new", slug: "new", name: "Shared" }], { new: ["Shared"] });
  assert.equal(g.get("new"), "Shared");
  assert.equal(g.get("old"), "Shared (old)");
});

test("folders stay unique however the names collide", () => {
  const names = ["Acme", "acme", "ACME", "Acme (b)", "acme (c)", "Acme (a)", "Acme (A)"];
  for (let round = 0; round < 50; round++) {
    const rows = names.map((name, i) => ({ id: `w${i}`, slug: "abc"[i % 3], name: names[(i + round) % names.length] }));
    const held: Record<string, string[]> = round % 2 ? { w3: ["Acme"], gone: ["acme (a)"] } : {};
    const keys = [...assignFolders(rows, held).values()].map((x) => x.normalize("NFC").toLowerCase());
    assert.equal(new Set(keys).size, keys.length, `round ${round}: ${keys.join(" | ")}`);
    for (const f of held.gone ?? []) assert.ok(!keys.includes(f.toLowerCase()), "nobody takes a deleted workspace's folder");
  }
});

test("ensureDownloadsDir makes the folder, private, and every other workspace is denied it — the old one too after a rename", () => {
  const acme = mkWs("Acme");
  const globex = mkWs("Globex");
  const dir = workspaces.ensureDownloadsDir(acme.id)!;
  assert.equal(dir, dl("Acme"));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(workspaces.isolationDenyDirs(globex.id).includes(dl("Acme")), "Globex's agents are denied Acme's folder");
  assert.ok(!workspaces.isolationDenyDirs(acme.id).includes(dl("Acme")), "never its own");
  assert.ok(workspaces.isolationDenyDirs(acme.id).includes(dl("Globex")), "denied before it even exists");

  workspaces.update(acme.id, { name: "Acme Corp" } as any);
  assert.equal(workspaces.ensureDownloadsDir(acme.id), dl("Acme Corp"));
  const deny = workspaces.isolationDenyDirs(globex.id);
  assert.ok(deny.includes(dl("Acme Corp")) && deny.includes(dl("Acme")), "the renamed workspace's old folder is still walled");
  assert.ok(!workspaces.isolationDenyDirs(acme.id).includes(dl("Acme")), "its own old folder is not denied to it");

  // A new workspace named like the old folder does not inherit it.
  const newco = mkWs("acme");
  assert.equal(workspaces.ensureDownloadsDir(newco.id), dl(`acme (${newco.slug})`));
  assert.ok(workspaces.isolationDenyDirs(newco.id).includes(dl("Acme")));

  // Deleting a workspace does not open its folders to anyone.
  workspaces.remove(acme.id);
  assert.ok(workspaces.isolationDenyDirs(globex.id).includes(dl("Acme Corp")));
  assert.equal(workspaces.ensureDownloadsDir("no-such-workspace"), null);
});

test("names the disk folds into one directory still get two folders on disk", () => {
  const a = workspaces.ensureDownloadsDir(mkWs("Straße").id)!;
  const b = workspaces.ensureDownloadsDir(mkWs("STRASSE").id)!;
  fs.writeFileSync(path.join(a, "only-in-a.txt"), "x");
  assert.equal(fs.existsSync(path.join(b, "only-in-a.txt")), false, `${a} and ${b} are one directory`);
});

async function finished(runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = runs.get(runId)!;
    if (r.status !== "queued" && r.status !== "running") return r;
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${r.status} after ${timeoutMs}ms`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
const spawnedWith = (runId: string, name: string) =>
  events.list(runId).filter((e) => e.type === "mock_env").map((e) => JSON.parse(e.payload)).find((p) => p.name === name)?.value ?? null;

test("a headless run of a workspace is handed its folder in MC_DOWNLOADS; a read-only run is not", async () => {
  const ws = mkWs("Acme");
  const cwd = fs.mkdtempSync(path.join(root, "cwd-"));
  const mk = (name: string) =>
    jobs.create({ name, goal: "export the numbers\n!env: MC_DOWNLOADS", cwd, sandbox: "off", backend: "mock", retry_max: 0, workspace_id: ws.id } as any);

  const r = dispatch(mk("weekly-export").id, "test", 0);
  assert.ok(!("error" in r), JSON.stringify(r));
  assert.equal((await finished((r as any).run_id)).status, "success");
  assert.equal(spawnedWith((r as any).run_id, "MC_DOWNLOADS"), dl("Acme"));
  assert.ok(fs.statSync(dl("Acme")).isDirectory());

  const ro = dispatch(mk("plan:acme-1").id, "test", 0);
  assert.ok(!("error" in ro), JSON.stringify(ro));
  await finished((ro as any).run_id);
  assert.equal(spawnedWith((ro as any).run_id, "MC_DOWNLOADS"), null, "a read-only run writes nothing, so it gets no folder");
});

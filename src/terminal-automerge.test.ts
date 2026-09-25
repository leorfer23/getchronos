import { test, after } from "node:test";
import assert from "node:assert/strict";
import { harvestSessionPrs, pollSessionPrs, recordSessionPrs, setGh } from "./terminal-automerge.js";
import { sessions, sessionPrs, workspaces } from "./store.js";

after(() => setGh(null));

const rnd = () => Math.random().toString(36).slice(2, 8);
const mkWs = (on: boolean) =>
  workspaces.create({ slug: `am-${rnd()}`, name: "am", config_dir: "/tmp/cfg", auto_merge_prs: on } as any);
const prUrl = () => `https://github.com/acme/repo/pull/${Math.floor(Math.random() * 1e6)}`;

type View = { state: string; isDraft?: boolean; author?: string; createdAt?: string; checks?: any[] | null };
function fakeGh(views: Record<string, View>, calls: string[][]) {
  setGh(async (args) => {
    calls.push(args);
    if (args[0] === "api") return "leo";
    if (args[0] === "pr" && args[1] === "merge") return "";
    const v = views[args[2]] ?? { state: "MERGED" }; // rows left open by earlier tests
    return JSON.stringify({
      state: v.state,
      isDraft: !!v.isDraft,
      author: { login: v.author ?? "leo" },
      createdAt: v.createdAt ?? new Date().toISOString(),
      statusCheckRollup: v.checks === undefined ? [{ status: "COMPLETED", conclusion: "SUCCESS" }] : v.checks,
    });
  });
}
const merges = (calls: string[][]) => calls.filter((c) => c[1] === "merge").map((c) => c[2]);

test("records only for auto_merge_prs workspaces, first sighting wins", () => {
  const on = mkWs(true);
  const off = mkWs(false);
  const a = sessions.create({ workspace_id: on.id, cwd: "/tmp", backend: "claude-code" });
  const b = sessions.create({ workspace_id: on.id, cwd: "/tmp", backend: "claude-code" });
  const c = sessions.create({ workspace_id: off.id, cwd: "/tmp", backend: "claude-code" });
  const url = prUrl();
  assert.equal(recordSessionPrs(a, [url, "https://evil.example/pull/1"]), 1);
  assert.equal(recordSessionPrs(b, [url]), 0);
  assert.equal(sessionPrs.get(url)?.session_id, a.id);
  assert.equal(recordSessionPrs(c, [prUrl()]), 0);
});

test("harvest picks PR links out of a live terminal's feed", () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const url = prUrl();
  harvestSessionPrs((id) => (id === s.id ? [{ kind: "say", text: `Opened ${url}.` } as any] : []));
  assert.equal(sessionPrs.get(url)?.session_id, s.id);
});

test("merges green CI; holds pending, red, draft; closes merged", async () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const [green, pending, red, draft, done] = [prUrl(), prUrl(), prUrl(), prUrl(), prUrl()];
  recordSessionPrs(s, [green, pending, red, draft, done]);
  const calls: string[][] = [];
  fakeGh({
    [green]: { state: "OPEN" },
    [pending]: { state: "OPEN", checks: [{ status: "IN_PROGRESS" }] },
    [red]: { state: "OPEN", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
    [draft]: { state: "OPEN", isDraft: true },
    [done]: { state: "MERGED" },
  }, calls);
  await pollSessionPrs();
  assert.deepEqual(merges(calls), [green]);
  assert.equal(sessionPrs.get(green)?.state, "merged");
  assert.equal(sessionPrs.get(pending)?.state, "open");
  assert.equal(sessionPrs.get(red)?.ci_state, "failing");
  assert.equal(sessionPrs.get(draft)?.state, "open");
  assert.equal(sessionPrs.get(done)?.state, "merged");
});

test("never merges a PR the terminal only quoted", async () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const [other, old] = [prUrl(), prUrl()];
  recordSessionPrs(s, [other, old]);
  const calls: string[][] = [];
  fakeGh({
    [other]: { state: "OPEN", author: "teammate" },
    [old]: { state: "OPEN", createdAt: "2020-01-01T00:00:00Z" },
  }, calls);
  await pollSessionPrs();
  assert.deepEqual(merges(calls), []);
  assert.equal(sessionPrs.get(other)?.state, "skipped");
  assert.equal(sessionPrs.get(old)?.state, "skipped");
});

test("no CI: waits out the grace window, then gives up without merging", async () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const url = prUrl();
  recordSessionPrs(s, [url]);
  const calls: string[][] = [];
  const created = new Date(Date.now() + 60_000).toISOString();
  fakeGh({ [url]: { state: "OPEN", checks: null, createdAt: created } }, calls);
  await pollSessionPrs(Date.parse(created) + 60_000);
  assert.equal(sessionPrs.get(url)?.state, "open");
  await pollSessionPrs(Date.parse(created) + 11 * 60_000);
  assert.equal(sessionPrs.get(url)?.state, "skipped");
  assert.deepEqual(merges(calls), []);
});

test("flag off: open rows are left alone", async () => {
  const ws = mkWs(true);
  const s = sessions.create({ workspace_id: ws.id, cwd: "/tmp", backend: "claude-code" });
  const url = prUrl();
  recordSessionPrs(s, [url]);
  workspaces.update(ws.id, { auto_merge_prs: false } as any);
  const calls: string[][] = [];
  fakeGh({ [url]: { state: "OPEN" } }, calls);
  await pollSessionPrs();
  assert.deepEqual(calls.filter((c) => c[2] === url), []);
});

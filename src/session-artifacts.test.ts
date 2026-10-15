/**
 * Pinned artifacts: the PRs a terminal opened and the docs it wrote, as the companion rail shows them.
 * Nothing here shells out — `gh` is injected (CLAUDE.md), and the DB half is exercised through the
 * in-memory store like every other store test.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { artifactsFromFeed, prStates, sessionArtifacts, setViewPr, clearPrCache } from "./session-artifacts.js";
import type { FocusEvent } from "./focus.js";
import type { Session } from "./types.js";
import { randomUUID } from "node:crypto";
import { repos, sessions, tickets, workspaces } from "./store.js";

let seq = 0;
const ev = (kind: string, text: string): FocusEvent => ({ seq: (seq += 1000), kind: kind as FocusEvent["kind"], text });

afterEach(() => {
  setViewPr(null);
  clearPrCache();
});

test("a PR the agent said is pinned once, with its repo and number", () => {
  const { prs } = artifactsFromFeed([
    ev("say", "opened [PR #412](https://github.com/leorfer23/getchronos/pull/412) — tests green"),
    ev("result", "Summary: https://github.com/leorfer23/getchronos/pull/412 is up for review."),
    ev("say", "also https://github.com/leorfer23/getchronos/pull/413."),
  ]);
  assert.deepEqual(prs, [
    { kind: "pr", url: "https://github.com/leorfer23/getchronos/pull/412", repo: "leorfer23/getchronos", num: 412 },
    { kind: "pr", url: "https://github.com/leorfer23/getchronos/pull/413", repo: "leorfer23/getchronos", num: 413 },
  ]);
});

test("a PR link inside a tool call counts, and the model's private thinking does not", () => {
  const { prs } = artifactsFromFeed([
    ev("act", "run gh pr view https://github.com/o/r/pull/7 --json state"),
    ev("think", "maybe https://github.com/o/r/pull/8 was the one"),
  ]);
  assert.deepEqual(prs.map((p) => p.num), [7]);
});

test("documents are the markdown a tool call WROTE — never what it read, never code", () => {
  const { docs } = artifactsFromFeed([
    ev("act", "Read /w/chronos/README.md"),
    ev("act", "Write /w/chronos/docs/AGENT-PASS.md"),
    ev("act", "Edit /w/chronos/src/api.ts"),
    ev("act", "Write /w/chronos/node_modules/pkg/readme.md"),
  ]);
  assert.deepEqual(docs, [{ kind: "doc", url: null, path: "/w/chronos/docs/AGENT-PASS.md", label: "docs/AGENT-PASS.md" }]);
});

test("the most recently written document sorts last, and is pinned once however often it is rewritten", () => {
  const { docs } = artifactsFromFeed([
    ev("act", "Write /w/a/PLAN.md"),
    ev("act", "Write /w/b/NOTES.md"),
    ev("act", "Edit /w/a/PLAN.md"),
  ]);
  assert.deepEqual(docs.map((d) => d.path), ["/w/b/NOTES.md", "/w/a/PLAN.md"]);
});

test("a hosted document is pinned by host, with the sentence's punctuation stripped off the link", () => {
  const { docs } = artifactsFromFeed([
    ev("say", "published at https://docs.google.com/document/d/1AbC/edit, have a look"),
    ev("result", "raw notes: https://raw.githubusercontent.com/o/r/main/docs/plan.md."),
  ]);
  assert.deepEqual(docs, [
    { kind: "doc", url: "https://docs.google.com/document/d/1AbC/edit", path: null, label: "docs.google.com" },
    { kind: "doc", url: "https://raw.githubusercontent.com/o/r/main/docs/plan.md", path: null, label: "docs/plan.md" },
  ]);
});

test("a merged PR is never re-fetched; an open one is re-checked after the TTL", async () => {
  const calls: string[] = [];
  setViewPr(async (url) => {
    calls.push(url);
    return url.endsWith("/1") ? { state: "MERGED", title: "landed" } : { state: "OPEN", title: "waiting on you" };
  });
  const ctx = { cwd: "/tmp", env: {} };
  const urls = ["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"];
  const first = await prStates(urls, ctx, 1_000);
  assert.equal(first.get(urls[0])!.state, "merged");
  assert.equal(first.get(urls[1])!.state, "open");
  assert.deepEqual(calls, urls);

  await prStates(urls, ctx, 5_000);           // inside the 90s window: nothing asked again
  assert.deepEqual(calls, urls);

  const later = await prStates(urls, ctx, 200_000); // past it: only the open one is worth asking about
  assert.deepEqual(calls, [...urls, urls[1]]);
  assert.equal(later.get(urls[0])!.state, "merged");
});

test("gh answering nothing leaves the last known state standing, not a blank one", async () => {
  const ctx = { cwd: "/tmp", env: {} };
  const url = "https://github.com/o/r/pull/9";
  setViewPr(async () => ({ state: "OPEN", title: "open for now" }));
  assert.equal((await prStates([url], ctx, 1_000)).get(url)!.state, "open");
  setViewPr(async () => null); // offline
  const after = await prStates([url], ctx, 200_000);
  assert.equal(after.get(url)!.state, "open");
  assert.equal(after.get(url)!.title, "open for now");
});

test("an unknown state is never reported as merged", async () => {
  setViewPr(async () => ({ state: "WEIRD" }));
  const got = await prStates(["https://github.com/o/r/pull/3"], { cwd: "/tmp", env: {} }, 1_000);
  assert.equal(got.get("https://github.com/o/r/pull/3")!.state, null);
});

test("the ticket's own PR is pinned first, with its polled state, and costs no gh call", async () => {
  const ws = workspaces.create({ slug: "art-" + randomUUID().slice(0, 8), name: "Artifacts ws", config_dir: `/tmp/mc-test/${randomUUID()}` } as any);
  const repo = repos.create({ workspace_id: ws.id, name: "chronos", path: "/tmp/mc-test/repo" } as any);
  const t = tickets.create({
    id: randomUUID(), workspace_id: ws.id, repo_id: repo.id, key: "CHR-1", slug: "pin-the-prs", title: "pin the PRs",
    status: "review", priority: "P2", complexity: null, backend: null, model: null, assignee: "agent",
    file_path: "/tmp/mc-test/CHR-1.md", external_system: null, external_id: null, external_url: null, tags: null,
  } as any);
  tickets.update(t.id, { pr_url: "https://github.com/o/r/pull/50", pr_state: "open" });
  const s = sessions.create({
    workspace_id: ws.id, repo_id: repo.id, ticket_id: t.id, cwd: "/tmp/mc-test/repo", backend: "claude-code", role: "human",
  } as any) as Session;

  let calls = 0;
  setViewPr(async () => { calls += 1; return { state: "MERGED", title: "the other one" }; });
  const out = await sessionArtifacts(s, [
    ev("say", "the ticket PR is https://github.com/o/r/pull/50"),
    ev("say", "and a follow-up: https://github.com/o/r/pull/51"),
  ]);
  assert.deepEqual(out.prs.map((p) => [p.num, p.state, p.source]), [[50, "open", "ticket"], [51, "merged", "feed"]]);
  assert.equal(calls, 1, "the ticket's PR is already polled by delivery.ts — asking gh again is waste");
  assert.equal(out.prs[0].title, "CHR-1 — pin the PRs");
});

test("a PR the terminal only PRINTED is pinned too, and never duplicates one the feed already has", async () => {
  setViewPr(async () => ({ state: "OPEN", title: "from the screen" }));
  const s = { id: "s1", cwd: "/tmp", workspace_id: null, repo_id: null, ticket_id: null } as unknown as Session;
  const out = await sessionArtifacts(s, [ev("say", "opened https://github.com/o/r/pull/60")], [
    "https://github.com/o/r/pull/60",
    "https://github.com/o/r/pull/61",
  ]);
  assert.deepEqual(out.prs.map((p) => p.num), [60, 61]);
});

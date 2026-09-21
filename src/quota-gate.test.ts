import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG } from "./config.js";
import { db, events, jobs, runs, workspaces } from "./store.js";
import { listBackends } from "./backends/index.js";
import { dispatch, setExecutor } from "./dispatcher.js";
import { parseResetClock } from "./manager-fallback.js";
import { operationalHealth } from "./operational-health.js";
import {
  blockMessage,
  buildSnapshot,
  chooseBackend,
  credentialFor,
  limitFromRun,
  probeAuth,
  quotaSnapshot,
  recentDecisions,
  resetQuotaGateState,
  setQuotaNotifier,
  setQuotaWaker,
  spendPriorityOf,
  type Candidate,
  type QuotaEntry,
  type QuotaSnapshot,
  type Surface,
} from "./quota-gate.js";
import type { RunStatus } from "./types.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const CONFIG_DIR = "/tmp/qg-profile";
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

/** A snapshot entry with everything unknown, so each test only states the fact it is about. */
function entry(over: Partial<QuotaEntry> = {}): QuotaEntry {
  return {
    provider: "anthropic",
    scope: "profile:qg-profile",
    effectivePercentRemaining: null,
    runway: "unknown",
    resetsAt: null,
    usableRunwaySeconds: null,
    confidence: "unknown",
    auth: "authenticated",
    inUse: true,
    attention: [],
    spendPriority: null,
    ...over,
  };
}
const snapOf = (...entries: QuotaEntry[]): QuotaSnapshot => ({ at: new Date().toISOString(), entries, attention: [] });

const claude: Candidate = { backend: "claude-code", model: "opus", reasoningClass: 4 };
const codex: Candidate = { backend: "codex", model: "gpt-5-codex", reasoningClass: 4 };
const ctx = (snapshot: QuotaSnapshot, over: Partial<Parameters<typeof chooseBackend>[1]> = {}) => ({
  reasoningClass: 4,
  horizonSeconds: 1800,
  snapshot,
  configDir: CONFIG_DIR,
  wsBackends: null,
  ...over,
});

// ── credential identity ──────────────────────────────────────────────────────

test("a candidate is keyed on the credential it ACTUALLY spends, not on its backend name", () => {
  // The whole point of per-workspace config_dir: two claude profiles are two accounts, and one being
  // rate-limited says nothing about the other.
  const a = credentialFor("claude-code", "/home/x/.claude-atlas")!;
  const b = credentialFor("claude-code", "/home/x/.claude-cedar")!;
  assert.equal(a.provider, "anthropic");
  assert.notEqual(a.scope, b.scope);
  // grok/opencode share one login across every workspace — so their scope must NOT vary by config dir.
  assert.deepEqual(credentialFor("grok", "/home/x/.claude-atlas"), credentialFor("grok", null));
  // A backend we model no credential for is never gated (this is what keeps `mock` dispatchable).
  assert.equal(credentialFor("mock", null), null);
});

// ── snapshot from recorded evidence ──────────────────────────────────────────

test("a recorded rate-limit becomes exhausted_now with its reset time, and expires when the window refills", () => {
  const future = iso(3_600_000);
  const row = {
    status: "rate_limited",
    error: "You've hit your session limit",
    resets_at: future,
    started_at: iso(-60_000),
    backend: "claude-code",
    config_dir: CONFIG_DIR,
  };
  const ev = limitFromRun(row)!;
  assert.equal(ev.kind, "rate_limit");
  assert.equal(ev.resetsAt, future);

  const surface: Surface = { ...credentialFor("claude-code", CONFIG_DIR)!, tokens: null, auth: "authenticated", authNote: null, inUse: true };
  const hot = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [ev], tokenBudget: 0, floors: {}, burn: null });
  assert.equal(hot.entries[0].runway, "exhausted_now");
  assert.equal(hot.entries[0].confidence, "measured");
  assert.equal(hot.entries[0].resetsAt, future);
  assert.match(hot.entries[0].attention.join(" "), /rate limited until/);

  // Past its reset the window has refilled: the same row must stop being evidence, or one bad hour
  // blocks the backend forever.
  const later = buildSnapshot({
    now: Date.parse(future) + 60_000,
    surfaces: [surface],
    limits: [ev],
    tokenBudget: 0,
    floors: {},
    burn: null,
  });
  assert.equal(later.entries[0].runway, "unknown");
  assert.equal(later.entries[0].effectivePercentRemaining, null);
});

test("an error naming credits is inferred evidence; an unrelated failure is no evidence at all", () => {
  const base = { status: "failed", resets_at: null, started_at: iso(-60_000), backend: "opencode", config_dir: null };
  assert.equal(limitFromRun({ ...base, error: "402 insufficient_balance" })!.kind, "credits");
  assert.equal(limitFromRun({ ...base, error: "You're out of usage credits. Switch to another model to continue." })!.kind, "credits");
  assert.equal(limitFromRun({ ...base, error: "TypeError: undefined is not a function" }), null);
  const ev = limitFromRun({ ...base, error: "Out of credits" })!;
  const surface: Surface = { ...credentialFor("opencode", null)!, tokens: null, auth: "indeterminate", authNote: null, inUse: true };
  const snap = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [ev], tokenBudget: 0, floors: {}, burn: null });
  assert.equal(snap.entries[0].runway, "exhausted_now");
  assert.equal(snap.entries[0].confidence, "inferred", "our reading of an error string is not the vendor saying it");
});

test("unknown is never coerced: no ceiling declared means null headroom, not 0 and not healthy", () => {
  const surface: Surface = { ...credentialFor("claude-code", CONFIG_DIR)!, tokens: 900, auth: "indeterminate", authNote: "keychain", inUse: true };
  const unknown = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [], tokenBudget: 0, floors: {}, burn: null });
  assert.equal(unknown.entries[0].effectivePercentRemaining, null);
  assert.equal(unknown.entries[0].runway, "unknown");
  assert.equal(unknown.entries[0].spendPriority, null);

  // With a declared ceiling the percentage is arithmetic, but a rolling window still has no reset, so
  // runway stays unprovable rather than being reported as fine.
  const measured = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [], tokenBudget: 1000, floors: {}, burn: null });
  assert.equal(Math.round(measured.entries[0].effectivePercentRemaining!), 10);
  assert.equal(measured.entries[0].runway, "unknown");
  assert.equal(measured.entries[0].confidence, "inferred");

  // Only the operator's own floor may turn that percentage into a refusal.
  const floored = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [], tokenBudget: 1000, floors: { anthropic: 25 }, burn: null });
  assert.equal(floored.entries[0].runway, "projected_exhaustion");
  assert.equal(floored.entries[0].usableRunwaySeconds, 0);
});

test("spendPriority needs BOTH halves, and 0 means exact utilization rather than unknown", () => {
  const now = Date.now();
  assert.equal(spendPriorityOf(null, iso(3_600_000), now), null);
  assert.equal(spendPriorityOf(50, null, now), null);
  // 60% left with 50% of the 5h window to go = +10: money on track to go unused.
  assert.equal(Math.round(spendPriorityOf(60, new Date(now + 2.5 * 3600_000).toISOString(), now)!), 10);
  assert.equal(Math.round(spendPriorityOf(50, new Date(now + 2.5 * 3600_000).toISOString(), now)!), 0);
  assert.ok(spendPriorityOf(10, new Date(now + 2.5 * 3600_000).toISOString(), now)! < 0);
});

test("a run that failed on 401 outranks a file probe that only says 'indeterminate'", () => {
  const ev = limitFromRun({
    status: "failed",
    error: "Not logged in · Please run /login",
    resets_at: null,
    started_at: iso(-60_000),
    backend: "claude-code",
    config_dir: CONFIG_DIR,
  })!;
  assert.equal(ev.kind, "auth");
  const surface: Surface = { ...credentialFor("claude-code", CONFIG_DIR)!, tokens: null, auth: "indeterminate", authNote: "keychain", inUse: true };
  const snap = buildSnapshot({ now: Date.now(), surfaces: [surface], limits: [ev], tokenBudget: 0, floors: {}, burn: null });
  assert.equal(snap.entries[0].auth, "unauthenticated");
});

test("probeAuth never renders a verdict it cannot prove", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-probe-"));
  try {
    // A profile dir that exists but holds no credentials file: claude may hold this login in the
    // keychain, so the only honest answer is indeterminate.
    assert.equal(probeAuth("claude-code", dir).auth, "indeterminate");
    // A dir that does not exist at all is the one case where there is provably nothing to log in with.
    assert.equal(probeAuth("claude-code", path.join(dir, "nope")).auth, "unauthenticated");
    // An expired short-lived OAuth token is renewed by the CLI on next use — not a sign-out.
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() - 1000 } }));
    assert.equal(probeAuth("claude-code", dir).auth, "indeterminate");
    fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600_000 } }));
    assert.equal(probeAuth("claude-code", dir).auth, "authenticated");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseResetClock reads the CLI's own wording, and a clock already past means tomorrow", () => {
  const noon = Date.parse("2026-09-12T12:00:00.000Z");
  const at = (text: string) => new Date(parseResetClock(text, noon)!);
  assert.equal(at("resets 1:40pm").getHours(), 13);
  assert.equal(at("resets 1:40pm").getMinutes(), 40);
  assert.equal(at("You've hit your session limit · resets at 14:00").getHours(), 14);
  // A time earlier in the day than now is the NEXT time that clock reads, never hours ago.
  assert.ok(at("resets 9am").getTime() > noon);
  assert.equal(parseResetClock("no reset here", noon), null);
});

// ── the three gates, each blocking alone ─────────────────────────────────────

test("eligibility alone blocks: an unauthenticated credential, an unknown backend, a workspace ban", () => {
  const blocked = chooseBackend([claude], ctx(snapOf(entry({ auth: "unauthenticated", attention: ["profile dir missing"] }))));
  assert.equal(blocked.choice, null);
  assert.match(blocked.blocked[0].why, /not logged in/);

  const unknown = chooseBackend([{ backend: "gemini-cli", model: "x", reasoningClass: 4 }], ctx(snapOf(entry())));
  assert.equal(unknown.choice, null);
  assert.match(unknown.summary, /not a registered backend/);

  const banned = chooseBackend([claude], ctx(snapOf(entry()), { wsBackends: JSON.stringify(["codex"]) }));
  assert.equal(banned.choice, null);
  assert.match(banned.blocked[0].why, /may not spawn/);
});

test("an indeterminate credential stays eligible, with the uncertainty disclosed", () => {
  const d = chooseBackend([claude], ctx(snapOf(entry({ auth: "indeterminate" }))));
  assert.equal(d.choice?.backend, "claude-code");
  assert.match(d.rationale.join("\n"), /login state indeterminate \(disclosed, not blocking\)/);
});

test("runway alone blocks: exhausted_now fails, and projected exhaustion fails only against the horizon", () => {
  const dead = chooseBackend([claude], ctx(snapOf(entry({ runway: "exhausted_now", resetsAt: iso(3_600_000), effectivePercentRemaining: 0 }))));
  assert.equal(dead.choice, null);
  assert.match(dead.blocked[0].why, /exhausted now, back at/);

  const tooShort = entry({ runway: "projected_exhaustion", usableRunwaySeconds: 300, effectivePercentRemaining: 5 });
  assert.equal(chooseBackend([claude], ctx(snapOf(tooShort), { horizonSeconds: 1800 })).choice, null);
  // Same window, a job that plausibly finishes inside it: the gate is a comparison, not a floor.
  assert.equal(chooseBackend([claude], ctx(snapOf(tooShort), { horizonSeconds: 120 })).choice?.backend, "claude-code");

  const throughReset = chooseBackend([claude], ctx(snapOf(entry({ runway: "through_reset", effectivePercentRemaining: 40 }))));
  assert.equal(throughReset.choice?.backend, "claude-code", "through_reset reaches its refill without exhausting");
});

test("unknown runway stays eligible — an unmeasured window is not an empty one", () => {
  const d = chooseBackend([claude], ctx(snapOf(entry({ runway: "unknown" }))));
  assert.equal(d.choice?.backend, "claude-code");
  assert.match(d.rationale.join("\n"), /runway unknown \(disclosed, not blocking\)/);
});

test("the reasoning class is never downgraded to save quota", () => {
  const weaker: Candidate = { backend: "codex", model: "gpt-5", reasoningClass: 2 };
  const snapshot = snapOf(
    entry({ scope: "profile:qg-profile", runway: "exhausted_now", resetsAt: iso(1_800_000), effectivePercentRemaining: 0 }),
    entry({ provider: "openai", scope: "codex:qg-profile", runway: "through_reset", effectivePercentRemaining: 90 }),
  );
  const d = chooseBackend([claude, weaker], ctx(snapshot));
  assert.equal(d.choice, null, "a healthy tier-2 rung is not a substitute for a blocked tier-4 one");
  assert.match(d.summary, /every candidate in class 4 is blocked/);
  assert.match(d.summary, /Not routing to a weaker class/);
  assert.match(d.rationale.join("\n"), /class 2<4/);
});

test("the headless-only gate follows the registry, not folklore about which CLI is interactive", () => {
  const grok: Candidate = { backend: "grok", model: "grok-4.5", reasoningClass: 4 };
  const snapshot = snapOf(
    entry({ scope: "profile:qg-profile", runway: "exhausted_now", effectivePercentRemaining: 0 }),
    entry({ provider: "xai", scope: "grok", runway: "through_reset", effectivePercentRemaining: 100, spendPriority: 60 }),
  );
  // grok grew a streaming-json headless mode, so it IS a legitimate stand-in for a headless build and
  // the gate must not invent the old limitation. If a backend ever declares supportsHeadless: false
  // again, this flips — and it must, because such a backend's buildArgs throws async and would strand
  // the ticket at in_progress rather than failing at the door.
  const d = chooseBackend([claude, grok], ctx(snapshot, { headlessOnly: true }));
  assert.equal(d.choice?.backend, "grok");
  assert.equal(
    listBackends().filter((b) => !b.supportsHeadless).length,
    0,
    "no registered backend is interactive-only today — the gate's headless refusal is a forward guard",
  );
});

// ── ranking ──────────────────────────────────────────────────────────────────

test("survivors rank by spendPriority, and a known scalar beats an unknown one", () => {
  const snapshot = snapOf(
    entry({ scope: "profile:qg-profile", runway: "through_reset", effectivePercentRemaining: 30, spendPriority: -5 }),
    entry({ provider: "openai", scope: "codex:qg-profile", runway: "through_reset", effectivePercentRemaining: 80, spendPriority: 22 }),
  );
  const d = chooseBackend([claude, codex], ctx(snapshot));
  assert.equal(d.choice?.backend, "codex", "the allowance most likely to go unused is the one to spend");
  assert.equal(d.tie, false);
  assert.match(d.summary, /highest spendPriority 22.0/);

  const oneUnknown = snapOf(
    entry({ scope: "profile:qg-profile", runway: "unknown" }),
    entry({ provider: "openai", scope: "codex:qg-profile", runway: "through_reset", effectivePercentRemaining: 80, spendPriority: 3 }),
  );
  assert.equal(chooseBackend([claude, codex], ctx(oneUnknown)).choice?.backend, "codex", "prefer known viable evidence");
});

test("a genuine tie takes the first candidate in the operator's route_config order, and says so", () => {
  const tied = snapOf(
    entry({ scope: "profile:qg-profile", runway: "through_reset", effectivePercentRemaining: 50, spendPriority: 11 }),
    entry({ provider: "openai", scope: "codex:qg-profile", runway: "through_reset", effectivePercentRemaining: 50, spendPriority: 11 }),
  );
  const d = chooseBackend([codex, claude], ctx(tied));
  assert.equal(d.choice?.backend, "codex", "first in the given order wins");
  assert.equal(d.tie, true);
  assert.match(d.summary, /taking the first in the operator's route_config order/);

  // Two unmeasurable candidates are also a tie — and unknown must not be ranked as if it were 0.
  const bothUnknown = snapOf(
    entry({ scope: "profile:qg-profile" }),
    entry({ provider: "openai", scope: "codex:qg-profile" }),
  );
  const u = chooseBackend([claude, codex], ctx(bothUnknown));
  assert.equal(u.choice?.backend, "claude-code");
  assert.equal(u.tie, true);
  assert.match(u.rationale.join("\n"), /spendPriority unknown/);
});

test("every candidate is accounted for in the rationale, blocked ones included", () => {
  const snapshot = snapOf(
    entry({ scope: "profile:qg-profile", runway: "exhausted_now", effectivePercentRemaining: 0 }),
    entry({ provider: "openai", scope: "codex:qg-profile", runway: "through_reset", effectivePercentRemaining: 80, spendPriority: 4 }),
  );
  const d = chooseBackend([claude, codex], ctx(snapshot));
  assert.equal(d.rationale.length, 2);
  assert.match(d.rationale[0], /claude-code\/opus · anthropic profile:qg-profile/);
  assert.match(d.rationale[1], /codex\/gpt-5-codex · openai codex:qg-profile/);
  assert.equal(d.blocked.length, 1);
  assert.equal(d.choice?.backend, "codex");
});

test("no candidates at all is reported, never guessed around", () => {
  const d = chooseBackend([], ctx(snapOf(entry())));
  assert.equal(d.choice, null);
  assert.match(d.summary, /no candidates/);
});

test("the page names each cause once, in words the operator can act on from a lock screen", () => {
  const snapshot = snapOf(
    entry({ scope: "profile:qg-profile", runway: "exhausted_now", resetsAt: "2026-09-12T14:00:00.000Z", effectivePercentRemaining: 0 }),
    entry({ provider: "openai", scope: "codex:qg-profile", auth: "unauthenticated", attention: ["CODEX_HOME does not exist"] }),
  );
  const d = chooseBackend([claude, codex], ctx(snapshot));
  assert.equal(d.choice, null);
  const msg = blockMessage("QG-9", d);
  assert.match(msg, /^QG-9 can't start — /);
  assert.match(msg, /Claude is out of allowance until 14:00/);
  assert.match(msg, /Codex isn't logged in/);
  assert.match(msg, /top up or say which backend to use\.$/);
});

// ── the dispatch seam: warn vs enforce, park + notify + wake ─────────────────

let profileDir: string;
let notified: string[];
let woken: Array<{ topic: string; payload?: unknown }>;
const savedGate = CONFIG.quotaGate;

beforeEach(() => {
  db.exec("DELETE FROM run_events; DELETE FROM runs; DELETE FROM jobs; DELETE FROM tickets; DELETE FROM workspaces;");
  resetQuotaGateState();
  notified = [];
  woken = [];
  setQuotaNotifier(async (t) => void notified.push(t));
  setQuotaWaker((w) => void woken.push(w));
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "qg-ws-"));
  // An authenticated profile, so these tests isolate the RUNWAY gate from the auth one.
  fs.writeFileSync(path.join(profileDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 36e5 } }));
  // Never the real executor (CLAUDE.md gotcha 2) — a scripted one that just lands a terminal status.
  setExecutor(async (_job, runId): Promise<RunStatus> => {
    runs.patch(runId, { status: "success", started_at: new Date().toISOString(), ended_at: new Date().toISOString(), cost_usd: 0 });
    return "success";
  });
});

afterEach(() => {
  CONFIG.quotaGate = savedGate;
  setExecutor(null);
  fs.rmSync(profileDir, { recursive: true, force: true });
});

/** A workspace on its own claude profile, with one recorded run that hit a wall on it. */
function wallOnProfile(): { wsId: string; resets: string } {
  const ws = workspaces.create({
    slug: "qg-" + randomUUID().slice(0, 6),
    name: "Quota Gate",
    config_dir: profileDir,
    default_backend: "claude-code",
  } as any);
  const dead = jobs.create({ name: "ticket:QG-1", goal: "g", workspace_id: ws.id, backend: "claude-code", model: "opus" } as any);
  const run = runs.create(dead.id, "manual");
  const resets = iso(2 * 3600_000);
  runs.patch(run.id, {
    status: "rate_limited",
    started_at: iso(-60_000),
    ended_at: iso(-30_000),
    resets_at: resets,
    error: "You've hit your session limit",
  });
  return { wsId: ws.id, resets };
}

test("the snapshot reads a recorded wall back off the DB, scoped to the profile that hit it", () => {
  CONFIG.quotaGate = "warn";
  const { wsId, resets } = wallOnProfile();
  const snap = quotaSnapshot();
  const mine = snap.entries.find((e) => e.scope === `profile:${path.basename(profileDir)}`);
  assert.ok(mine, "the workspace's own profile is a reported surface");
  assert.equal(mine!.runway, "exhausted_now");
  assert.equal(mine!.resetsAt, resets);
  assert.equal(mine!.inUse, true);
  // …and the default profile, which nobody in this test dispatched on, is untouched by it.
  const other = snap.entries.find((e) => e.provider === "anthropic" && e.scope !== mine!.scope);
  if (other) assert.notEqual(other.runway, "exhausted_now");
  assert.ok(wsId);
});

test("warn mode records the verdict on the run and dispatches anyway", () => {
  CONFIG.quotaGate = "warn";
  const { wsId } = wallOnProfile();
  const job = jobs.create({ name: "ticket:QG-2", goal: "g", workspace_id: wsId, backend: "claude-code", model: "opus", retry_max: 0 } as any);

  const r = dispatch(job.id, "manual");
  assert.ok(!("error" in r));
  assert.notEqual((r as any).status, "blocked", "warn never blocks — that is the whole point of the first deploy");

  const line = events.list((r as any).run_id).find((e) => e.type === "route");
  assert.ok(line, "the verdict is on the run, not only in the log");
  assert.match(JSON.parse(line!.payload).text, /route: BLOCKED/);
  assert.equal(notified.length, 0, "warn mode does not park, so it must not page anyone either");
  assert.equal(woken.length, 0);
  assert.equal(recentDecisions()[0].mode, "warn");
});

test("enforce mode parks the run, tells the operator in plain words, and wakes Robert", () => {
  CONFIG.quotaGate = "enforce";
  const { wsId } = wallOnProfile();
  const job = jobs.create({ name: "ticket:QG-3", goal: "g", workspace_id: wsId, backend: "claude-code", model: "opus", retry_max: 0 } as any);

  const r = dispatch(job.id, "manual") as { run_id: string; status: string };
  assert.equal(r.status, "blocked");
  const run = runs.get(r.run_id)!;
  assert.match(run.error ?? "", /^no viable backend: /);
  assert.match(run.error ?? "", /every candidate in class 3 is blocked/);
  assert.ok(run.ended_at, "a parked run is finished, not left looking live");

  assert.equal(notified.length, 1);
  assert.match(notified[0], /QG-3 can't start/);
  assert.match(notified[0], /Claude is out of allowance until \d\d:\d\d/);
  assert.match(notified[0], /top up or say which backend to use/);
  // Two route_config rungs on one exhausted profile are ONE fact — the page must not say it twice.
  assert.equal(notified[0].match(/out of allowance/g)!.length, 1);

  assert.equal(woken.length, 1);
  assert.equal(woken[0].topic, "quota.blocked");
  assert.match(String((woken[0].payload as { say: string }).say), /can't start/);
  assert.match(String((woken[0].payload as { say: string }).say), /GET \/api\/quota/);
});

test("enforce mode repeats the alert to Robert per ticket but pages the operator once", () => {
  CONFIG.quotaGate = "enforce";
  const { wsId } = wallOnProfile();
  for (const name of ["ticket:QG-4", "ticket:QG-5"]) {
    const job = jobs.create({ name, goal: "g", workspace_id: wsId, backend: "claude-code", model: "opus", retry_max: 0 } as any);
    dispatch(job.id, "manual");
  }
  assert.equal(notified.length, 1, "a blocked tier re-parks every ticket behind it — the operator hears it once");
  assert.equal(woken.length, 2, "but each piece of work still gets a call made on it");
});

test("gate off dispatches without a verdict, and health says nothing about quota", () => {
  CONFIG.quotaGate = "off";
  const { wsId } = wallOnProfile();
  const job = jobs.create({ name: "ticket:QG-6", goal: "g", workspace_id: wsId, backend: "claude-code", model: "opus", retry_max: 0 } as any);
  const r = dispatch(job.id, "manual") as { run_id: string; status: string };
  assert.equal(r.status, "queued");
  assert.equal(events.list(r.run_id).filter((e) => e.type === "route").length, 0);
  assert.equal(operationalHealth().issues.filter((i) => i.kind === "quota").length, 0);
});

test("an exhausted credential in use is a critical operational issue", () => {
  CONFIG.quotaGate = "warn";
  wallOnProfile();
  const iss = operationalHealth().issues.find((i) => i.id.startsWith("quota-exhausted:anthropic:"));
  assert.ok(iss, "the fact that used to surface only as a failed run an hour later");
  assert.equal(iss!.severity, "critical");
  assert.match(iss!.fix, /another backend/);
});

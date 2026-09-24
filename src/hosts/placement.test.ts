/**
 * place() (HOSTS.md → Placement) as a pure function: every rule on made-up computers, no store, no
 * link, no clock — the way machine.test.ts pins admission(). What the brain does with the answer is
 * covered in placement.integration.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MachineLoad } from "../machine.js";
import { cliFor, headroom, ineligible, place, type HostCandidate, type PlaceInput, type PlaceRequest } from "./placement.js";

const CFG = { enabled: true, maxLoadPerCore: 2.5, maxSwapUsedPct: 90 };

const load = (loadPerCore: number, over: Partial<MachineLoad> = {}): MachineLoad => ({
  load1: loadPerCore * 12, ncpu: 12, loadPerCore, swapUsedMb: 1000, swapTotalMb: 4000, pressureLevel: 1, ...over,
});
/** The operator's 18 GB M3 on 2026-09-24: load 234, pressure warning, swap 93%. */
const THRASHING = load(234 / 12, { pressureLevel: 2, swapUsedMb: 12400, swapTotalMb: 13312 });
const IDLE = load(0.1);

const brain = (over: Partial<HostCandidate> = {}): HostCandidate => ({
  id: "local", name: "local", is_brain: true, online: true, status: "online", deny: [], veto: [], platform: "darwin", sandbox: true,
  clis: [], profiles: [], checkouts: [], auto_clone: false, load: IDLE, ram_pct: 40, ...over,
});
const host = (id: string, over: Partial<HostCandidate> = {}): HostCandidate => ({
  id, name: id, is_brain: false, online: true, status: "online", deny: [], veto: [], platform: "darwin", sandbox: true,
  clis: ["claude", "cursor-agent", "git", "gh"], profiles: [{ name: "claude", exists: true }, { name: "claude-acme", exists: true }],
  checkouts: ["repo-web"], auto_clone: false, load: IDLE, ram_pct: 40, ...over,
});
const WS = { id: "ws-acme", slug: "acme" };
const req = (over: Partial<PlaceRequest> = {}): PlaceRequest => ({
  workspace: WS, backend: "claude-code", backend_kind: "local", profile: "claude-acme", repo: null,
  needs: { sandbox: "guard", egress_locked: false }, pinned: null, sticky: null, opened_by: "operator", fresh: true, ...over,
});
const run = (r: PlaceRequest, hosts: HostCandidate[], over: Partial<PlaceInput> = {}) =>
  place({ req: r, hosts, cfg: CFG, reserve: 25, mode: "auto", ...over });
const hostOf = (p: ReturnType<typeof place>) => (p.ok ? p.host_id : `refused: ${p.message}`);

// ───────────────────────────── one computer: exactly the old behavior ─────────────────────────────

test("one computer: everything lands on the brain, with nothing to say about it", () => {
  const p = run(req(), [brain()]);
  assert.deepEqual(p, { ok: true, host_id: "local", reason: "the only computer", chose: false });
  assert.equal(hostOf(run(req({ opened_by: "agent" }), [brain()])), "local");
});

test("one computer, saturated: an agent is refused in today's words, the operator is not", () => {
  const b = brain({ load: THRASHING });
  const p = run(req({ opened_by: "agent" }), [b]);
  assert.equal(p.ok, false);
  assert.match((p as any).message, /^machine saturated — load 234\.0 on 12 cores, memory pressure warning \(swap 93% used\); retry when workers finish$/);
  assert.equal((p as any).kind, "full");
  assert.equal(hostOf(run(req(), [b])), "local");
});

test("one computer: a sticky or pinned brain is admitted like any agent open, and a stand-in never refused", () => {
  const b = brain({ load: THRASHING });
  const sticky = { host_id: "local", why: "its CLI transcript is on that computer" };
  assert.match((run(req({ opened_by: "agent", sticky }), [b]) as any).message, /^machine saturated — /);
  assert.match((run(req({ opened_by: "agent", pinned: "local" }), [b]) as any).message, /^machine saturated — /);
  assert.equal(hostOf(run(req({ opened_by: "agent", sticky, exempt_admission: true }), [b])), "local");
  assert.equal(hostOf(run(req({ opened_by: "agent", exempt_admission: true }), [b])), "local", "even with nothing to be sticky to");
});

test("the governor switched off admits everyone everywhere", () => {
  const p = place({ req: req({ opened_by: "agent" }), hosts: [brain({ load: THRASHING })], cfg: { ...CFG, enabled: false }, reserve: 25, mode: "auto" });
  assert.equal(hostOf(p), "local");
});

// ───────────────────────────── headroom and the brain's reserve ─────────────────────────────

test("headroom: half CPU against the governor's ceiling, half free RAM, pressure takes points off", () => {
  assert.equal(headroom({ load: load(0), ram_pct: 0 }, CFG), 100);
  assert.equal(headroom({ load: load(2.5), ram_pct: 100 }, CFG), 0);
  assert.equal(headroom({ load: load(1.25), ram_pct: 50 }, CFG), 50);
  assert.equal(headroom({ load: load(0, { pressureLevel: 2 }), ram_pct: 0 }, CFG), 75);
  assert.equal(headroom({ load: load(0, { pressureLevel: 4 }), ram_pct: 0 }, CFG), 50);
  // Swap only counts under pressure: a full small swapfile is a calm Mac's resting state.
  assert.equal(headroom({ load: load(0, { swapUsedMb: 3900 }), ram_pct: 0 }, CFG), 100);
  assert.equal(headroom({ load: load(0, { pressureLevel: 2, swapUsedMb: 3900 }), ram_pct: 0 }, CFG), 65);
  assert.equal(headroom({ load: load(0), ram_pct: null }, CFG), 75, "unknown RAM counts as half full");
  assert.equal(headroom({ load: null, ram_pct: 10 }, CFG), 0, "no reading is never the most attractive");
});

test("the reserve tips work to a host the brain would otherwise beat", () => {
  // Brain score 60, host 45: without a reserve the brain wins; with 25 off the brain's, the host does.
  const b = brain({ load: load(1.0), ram_pct: 20 }); // 0.5*60 + 0.5*80 = 70
  const m2 = host("m2", { load: load(1.25), ram_pct: 40 }); // 0.5*50 + 0.5*60 = 55
  assert.equal(hostOf(run(req(), [b, m2], { reserve: 0 })), "local");
  const p = run(req(), [b, m2], { reserve: 25 });
  assert.equal(hostOf(p), "m2");
  assert.equal((p as any).reason, "most headroom (m2 55 · local 70−25)");
  assert.equal((p as any).chose, true);
});

test("…and the brain still takes the overflow once the host is busier than the reserve", () => {
  const b = brain({ load: load(0.25), ram_pct: 40 }); // 75 − 25 = 50
  const m2 = host("m2", { load: load(2.0), ram_pct: 70 }); // 0.5*20 + 0.5*30 = 25
  const p = run(req(), [b, m2]);
  assert.equal(hostOf(p), "local");
  assert.match((p as any).reason, /^most headroom \(local 75−25 · m2 25\)$/);
});

test("most headroom among several hosts; an unadmitted one is skipped even when it scores higher", () => {
  const hosts = [brain({ load: load(2.0), ram_pct: 80 }), host("m2", { load: load(1.5), ram_pct: 60 }), host("m5", { load: load(0.5), ram_pct: 50 })];
  assert.equal(hostOf(run(req(), hosts)), "m5");
  // m5 scores best on RAM and CPU but its memory is critical: admission refuses it, m2 gets the work.
  const critical = [hosts[0], hosts[1], host("m5", { load: load(0.1, { pressureLevel: 4 }), ram_pct: 5 })];
  assert.equal(hostOf(run(req({ opened_by: "agent" }), critical)), "m2");
});

test("ties break deterministically: a host before the brain, then by name, then by id", () => {
  const same = { load: load(0.5), ram_pct: 50 };
  assert.equal(hostOf(run(req(), [brain(same), host("m2", same)], { reserve: 0 })), "m2");
  assert.equal(hostOf(run(req(), [brain(same), host("zz", same), host("aa", same)], { reserve: 0 })), "aa");
  assert.equal(hostOf(run(req(), [brain(same), host("h2", { ...same, name: "twin" }), host("h1", { ...same, name: "twin" })], { reserve: 0 })), "h1");
  // Input order does not matter.
  const a = run(req(), [host("b", same), brain(same), host("a", same)]);
  const b = run(req(), [host("a", same), host("b", same), brain(same)]);
  assert.deepEqual(a, b);
});

// ───────────────────────────── eligibility ─────────────────────────────

test("brain policy and the host's own veto both keep a workspace off a host, by id or slug", () => {
  const b = brain({ load: load(2.0), ram_pct: 90 });
  for (const h of [host("m2", { deny: ["ws-acme"] }), host("m2", { deny: ["acme"] }), host("m2", { veto: ["acme"] })]) {
    const p = run(req(), [b, h]);
    assert.equal(hostOf(p), "local", "the brain takes it, however busy");
    assert.match((p as any).reason, /the only computer that can run it \(m2: workspace acme is not allowed on host m2/);
  }
  assert.equal(hostOf(run(req(), [b, host("m2", { deny: ["someone-else"] })])), "m2");
});

test("a pin to a denied host is a policy refusal (403), even for the operator", () => {
  const p = run(req({ pinned: "m2" }), [brain(), host("m2", { veto: ["acme"] })]);
  assert.equal(p.ok, false);
  assert.equal((p as any).kind, "policy");
  assert.match((p as any).message, /^workspace acme is not allowed on host m2 \(its own veto\)$/);
});

test("capability gaps: CLI, profile, logged-in profile, repo, git remote", () => {
  const h = host("m2");
  const why = (r: PlaceRequest, c = h) => ineligible(c, r)?.reason ?? null;
  assert.equal(why(req()), null);
  assert.equal(why(req({ backend: "grok" })), "grok not installed");
  assert.equal(why(req({ backend: "cursor" })), null);
  assert.equal(why(req({ backend: "mock" })), null, "the test stand-in needs no CLI");
  assert.equal(cliFor("opencode"), "opencode");
  assert.equal(why(req({ profile: "claude-globex" })), "profile claude-globex not set up there");
  const loggedOut = host("m2", { profiles: [{ name: "claude-acme", exists: false }] });
  assert.equal(why(req(), loggedOut), "profile claude-acme not set up there", "claude-code needs its login dir");
  assert.equal(why(req({ backend: "cursor" }), loggedOut), null, "other CLIs only need the name");
  assert.equal(why(req({ repo: { id: "repo-web", name: "web", git_remote: "git@github.com:acme/web.git" } })), null);
  assert.equal(why(req({ repo: { id: "repo-api", name: "api", git_remote: "git@github.com:acme/api.git" } })), "api not checked out");
  assert.equal(why(req({ repo: { id: "repo-api", name: "api", git_remote: "git@github.com:acme/api.git" } }), host("m2", { auto_clone: true })), null, "auto_clone clones it on arrival");
  assert.equal(why(req({ repo: { id: "repo-web", name: "web", git_remote: null } })), "repo web has no git remote to find it by");
});

test("a repo-less terminal can go to any eligible host", () => {
  const hosts = [brain({ load: load(2.0), ram_pct: 80 }), host("m2", { checkouts: [] })];
  assert.equal(hostOf(run(req({ repo: null }), hosts)), "m2");
  assert.equal(hostOf(run(req({ repo: { id: "repo-web", name: "web", git_remote: "x" } }), hosts)), "local", "…but not a repo it lacks");
});

test("egress-locked workspaces, cloud backends, non-macOS and unsandboxable hosts stay off", () => {
  const b = brain({ load: load(2.0), ram_pct: 80 });
  assert.equal(hostOf(run(req({ needs: { sandbox: "guard", egress_locked: true } }), [b, host("m2")])), "local");
  assert.equal(hostOf(run(req({ backend: "cursor-cloud", backend_kind: "cloud" }), [b, host("m2", { clis: ["cursor-cloud"] })])), "local");
  assert.equal(hostOf(run(req(), [b, host("lin", { platform: "linux" })])), "local");
  assert.equal(hostOf(run(req(), [b, host("m2", { sandbox: false })])), "local");
  assert.equal(hostOf(run(req({ needs: { sandbox: "off", egress_locked: false } }), [b, host("m2", { sandbox: false })])), "m2");
});

test("offline, draining and disabled hosts take no new work", () => {
  const b = brain({ load: load(2.0), ram_pct: 80 });
  for (const h of [host("m2", { online: false }), host("m2", { status: "draining" }), host("m2", { status: "disabled" })]) {
    assert.equal(hostOf(run(req(), [b, h])), "local");
  }
  // A draining host still finishes what it has: a reopen of its own terminal stays there.
  const sticky = { host_id: "m2", why: "its CLI transcript is on that computer" };
  assert.equal(hostOf(run(req({ sticky, fresh: false }), [b, host("m2", { status: "draining" })])), "m2");
  assert.match(hostOf(run(req({ sticky, fresh: true }), [b, host("m2", { status: "draining" })])), /refused: .*draining/);
});

test("a host with no recent vitals is eligible but never admits an agent", () => {
  const hosts = [brain({ load: THRASHING }), host("m2", { load: null })];
  const p = run(req({ opened_by: "agent" }), hosts);
  assert.equal(p.ok, false);
  assert.match((p as any).message, /m2: no recent vitals from m2/);
  assert.equal(hostOf(run(req(), hosts)), "local", "the operator gets the least-bad: the brain scores above an unknown");
});

// ───────────────────────────── sticky and pinned ─────────────────────────────

test("sticky wins over headroom, and never moves silently: an offline sticky host is a refusal", () => {
  const hosts = [brain(), host("m2", { load: load(2.4), ram_pct: 95 }), host("m5")];
  const sticky = { host_id: "m2", why: "its CLI transcript is on that computer" };
  const p = run(req({ sticky, fresh: false }), hosts);
  assert.deepEqual(p, { ok: true, host_id: "m2", reason: "sticky — its CLI transcript is on that computer", chose: false });
  const off = run(req({ sticky, fresh: false }), [brain(), host("m2", { online: false }), host("m5")]);
  assert.equal(off.ok, false);
  assert.equal((off as any).kind, "unavailable");
  assert.equal((off as any).message, "cannot move (its CLI transcript is on that computer) — m2: offline");
  // Even the operator: the transcript is on that disk.
  assert.equal(run(req({ sticky, fresh: false, opened_by: "operator" }), [brain(), host("m2", { online: false })]).ok, false);
});

test("sticky to a host that lost the capability is refused with the gap", () => {
  const sticky = { host_id: "m2", why: "ACME-12's worktree is on that computer" };
  const p = run(req({ sticky }), [brain(), host("m2", { clis: ["git"] })]);
  assert.match(hostOf(p), /^refused: cannot move \(ACME-12's worktree is on that computer\) — m2: claude not installed$/);
});

test("a sticky agent open on a saturated host is refused; a stand-in is not", () => {
  const hosts = [brain(), host("m2", { load: THRASHING })];
  const sticky = { host_id: "m2", why: "it stands in for a terminal whose files are there" };
  assert.match(hostOf(run(req({ sticky, opened_by: "agent", fresh: false }), hosts)), /^refused: m2 is saturated — load 234\.0 on 12 cores/);
  assert.equal(hostOf(run(req({ sticky, opened_by: "agent", fresh: false, exempt_admission: true }), hosts)), "m2");
});

test("a pin that disagrees with where the work lives is refused, not obeyed", () => {
  const p = run(req({ pinned: "m5", sticky: { host_id: "m2", why: "ACME-12's worktree is on that computer" } }), [brain(), host("m2"), host("m5")]);
  assert.match(hostOf(p), /^refused: ACME-12's worktree is on that computer on m2, but this terminal was pinned to m5/);
  assert.equal(hostOf(run(req({ pinned: "m2", sticky: { host_id: "m2", why: "x" } }), [brain(), host("m2")])), "m2", "agreeing is fine");
});

test("pinned beats headroom; a pin to an offline or unknown host is refused (409), never rerouted", () => {
  const hosts = [brain({ load: load(0), ram_pct: 0 }), host("m2", { load: load(2.4), ram_pct: 95 })];
  assert.deepEqual(run(req({ pinned: "m2" }), hosts), { ok: true, host_id: "m2", reason: "pinned", chose: false });
  const off = run(req({ pinned: "m2" }), [brain(), host("m2", { online: false })]);
  assert.equal((off as any).kind, "unavailable");
  assert.equal((off as any).message, "m2: offline");
  assert.match(hostOf(run(req({ pinned: "ghost" }), [brain()])), /unknown computer `ghost`/);
  assert.equal(hostOf(run(req({ pinned: "local" }), hosts)), "local", "pinning the brain is a pin too");
});

test("a pinned agent onto a full host is refused with that host's numbers", () => {
  const p = run(req({ pinned: "m2", opened_by: "agent" }), [brain(), host("m2", { load: THRASHING })]);
  assert.equal((p as any).kind, "full");
  assert.match((p as any).message, /^m2 is saturated — load 234\.0 on 12 cores, memory pressure warning/);
  assert.equal(hostOf(run(req({ pinned: "m2" }), [brain(), host("m2", { load: THRASHING })])), "m2", "the operator's pin stands");
});

// ───────────────────────────── nobody has room ─────────────────────────────

test("all full: the operator gets the least-loaded computer, an agent every computer's reason in one line", () => {
  const hosts = [
    brain({ load: THRASHING, ram_pct: 97 }),
    host("m2", { load: load(3.1, { load1: 37.2 }), ram_pct: 60 }),
    host("m5", { online: false }),
  ];
  const op = run(req(), hosts);
  assert.equal(hostOf(op), "m2");
  assert.match((op as any).reason, /^every computer is busy — least loaded \(/);
  const ag = run(req({ opened_by: "agent" }), hosts);
  assert.equal(ag.ok, false);
  assert.equal((ag as any).kind, "full");
  assert.equal(
    (ag as any).message,
    "no computer has room — m2: load 37.2 on 12 cores, memory pressure normal (swap 25% used); retry when workers finish; m5: offline; " +
      "local: load 234.0 on 12 cores, memory pressure warning (swap 93% used); retry when workers finish",
  );
  assert.deepEqual(Object.keys((ag as any).reasons).sort(), ["local", "m2", "m5"]);
});

// ───────────────────────────── the kill switch ─────────────────────────────

test("CHRONOS_PLACEMENT=pinned is phase 3: only a pin or sticky leaves the brain", () => {
  const hosts = [brain({ load: load(2.0), ram_pct: 90 }), host("m2")];
  assert.equal(hostOf(run(req(), hosts, { mode: "pinned" })), "local");
  assert.equal((run(req(), hosts, { mode: "pinned" }) as any).chose, false, "nothing to choose: the brain alone was in play");
  assert.equal(hostOf(run(req({ pinned: "m2" }), hosts, { mode: "pinned" })), "m2");
  assert.equal(hostOf(run(req({ sticky: { host_id: "m2", why: "x" }, fresh: false }), hosts, { mode: "pinned" })), "m2");
  // An agent refused by a full brain hears today's words — the host was never in play.
  assert.match(hostOf(run(req({ opened_by: "agent" }), [brain({ load: THRASHING }), host("m2")], { mode: "pinned" })), /^refused: machine saturated — /);
});

test("CHRONOS_PLACEMENT=local refuses pins elsewhere but still reopens a terminal where it lives", () => {
  const hosts = [brain({ load: load(2.0), ram_pct: 90 }), host("m2")];
  assert.equal(hostOf(run(req(), hosts, { mode: "local" })), "local");
  assert.match(hostOf(run(req({ pinned: "m2" }), hosts, { mode: "local" })), /CHRONOS_PLACEMENT=local/);
  assert.equal(hostOf(run(req({ pinned: "local" }), hosts, { mode: "local" })), "local");
  assert.equal(hostOf(run(req({ sticky: { host_id: "m2", why: "x" }, fresh: false }), hosts, { mode: "local" })), "m2");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentsForTick,
  heartbeatKind,
  isSilenceReply,
  isWithinActiveHours,
  parseGateReply,
  parseHm,
  proposalAgentFor,
  runAgentHeartbeat,
  standupPrompt,
  standupSince,
  workspaceTargets,
  type FleetAgent,
} from "./heartbeat.js";

test("parseHm accepts HH:MM and optional 24:00", () => {
  assert.equal(parseHm("09:00"), 9 * 60);
  assert.equal(parseHm("20:00"), 20 * 60);
  assert.equal(parseHm("24:00", true), 24 * 60);
  assert.equal(parseHm("24:00", false), null);
  assert.equal(parseHm("9:00"), null);
});

test("active hours 09:00–20:00 inclusive start exclusive end", () => {
  assert.equal(isWithinActiveHours(new Date(2026, 6, 27, 9, 0), "09:00", "20:00"), true);
  assert.equal(isWithinActiveHours(new Date(2026, 6, 27, 19, 30), "09:00", "20:00"), true);
  assert.equal(isWithinActiveHours(new Date(2026, 6, 27, 20, 0), "09:00", "20:00"), false);
  assert.equal(isWithinActiveHours(new Date(2026, 6, 27, 8, 59), "09:00", "20:00"), false);
});

test("heartbeatKind: morning at window open, evening at last slot, else hourly", () => {
  assert.equal(heartbeatKind(9, 0), "morning");
  assert.equal(heartbeatKind(9, 15), "morning");
  assert.equal(heartbeatKind(10, 0), "hourly");
  assert.equal(heartbeatKind(17, 0), "hourly");
  assert.equal(heartbeatKind(18, 0), "hourly");
  assert.equal(heartbeatKind(19, 0), "hourly");
  assert.equal(heartbeatKind(19, 30), "evening");
});

test("proposal rotation: one executive, every slot filled, no dead slots", () => {
  // Ada, Nils and Iris were retired, so ROTATION is a single entry. The invariant that
  // matters is that a one-element rotation does not leave holes: the modulo must still resolve
  // EVERY half-hour slot to a real executive, not skip the ones the retired three used to own.
  for (let h = 0; h < 24; h++)
    for (const m of [0, 30])
      assert.equal(proposalAgentFor(new Date(2026, 6, 27, h, m)), "robert", `${h}:${m}`);

  assert.deepEqual(agentsForTick("hourly", new Date(2026, 6, 27, 10, 30)), ["robert"]);
  assert.deepEqual(agentsForTick("morning", new Date(2026, 6, 27, 9, 0)), ["robert"]);
  assert.deepEqual(agentsForTick("evening", new Date(2026, 6, 27, 19, 30)), ["robert"]);
  // A forced full-fleet run is the operator asking for everyone — which is now the same one person.
  assert.deepEqual(agentsForTick("now", new Date(2026, 6, 27, 10, 30), true), ["robert"]);
});

test("agentDigest: a fingerprint of content, not of the clock", async () => {
  const { agentDigest } = await import("./heartbeat.js");
  // Same data, 40 minutes apart and across a half-hour boundary: identical fingerprint. A digest
  // that embeds slot=HH:MM rotates every 30 minutes and silently defeats digestSkip — the skip
  // depends on "nothing moved" being a stable string.
  const a = agentDigest("robert", new Date(2026, 6, 27, 14, 10));
  const b = agentDigest("robert", new Date(2026, 6, 27, 14, 50));
  assert.equal(a, b);
  assert.ok(!/slot=/.test(a), "no clock component");
});

test("parseGateReply: only WAKE wakes; NOOP/HEARTBEAT_OK silent", () => {
  assert.deepEqual(parseGateReply("NOOP"), { wake: false, reason: "" });
  assert.deepEqual(parseGateReply("HEARTBEAT_OK"), { wake: false, reason: "" });
  assert.deepEqual(parseGateReply("WAKE calendar gap at 5pm — suggest run"), {
    wake: true,
    reason: "calendar gap at 5pm — suggest run",
  });
  assert.deepEqual(parseGateReply("WAKE: pending review ACM-58"), {
    wake: true,
    reason: "pending review ACM-58",
  });
  // Chatty garbage must not wake
  assert.deepEqual(parseGateReply("Sure, I think you should check reviews"), {
    wake: false,
    reason: "",
  });
});

test("isSilenceReply: NOOP / HEARTBEAT_OK is the verdict wherever it lands", () => {
  assert.equal(isSilenceReply("NOOP"), true);
  assert.equal(isSilenceReply("HEARTBEAT_OK"), true);
  assert.equal(isSilenceReply("HEARTBEAT_OK all good"), true);
  assert.equal(isSilenceReply("**HEARTBEAT_OK**"), true);
  // Trailing token: the sweep's real-world failure mode.
  assert.equal(isSilenceReply("No new mail since last check.\n\nNOOP"), true);
  assert.equal(isSilenceReply("Only new one is a promo — noise, not important.\n\nNOOP"), true);
  assert.equal(isSilenceReply("nothing fresh — **NOOP**"), true);
  // Leading token with a long explanation: still silence, no length cap.
  assert.equal(
    isSilenceReply(
      "NOOP — chequeé el fleet entero: nada se movió desde el último digest. " +
        "ACM-2, ACM-14, PER-29, PER-30, PER-31, PER-32 siguen en review sin mergear; " +
        "el piloto sigue igual, las ideas propuestas son las mismas de ayer, no hay asks nuevos, " +
        "no hay P0 estancados nuevos, el calendario no cambió y no encontré ningún ángulo fresco " +
        "que no te haya propuesto ya en las últimas rondas de heartbeat de esta semana."
    ),
    true
  );
  assert.equal(isSilenceReply("Ship ACM-58 — gates green."), false);
  // Token mid-sentence is not a verdict.
  assert.equal(isSilenceReply("The NOOP handling in heartbeat.ts needs a fix — proposing a ticket."), false);
});

test("runAgentHeartbeat: unchanged digest skips before gate", async () => {
  const agent: FleetAgent = "robert";
  const { kv } = await import("./store.js");
  // Verify the skip path by seeding kv with the LIVE digest, so the tick sees nothing moved.
  const { agentDigest } = await import("./heartbeat.js");
  const live = agentDigest(agent);
  kv.set(`heartbeat.digest.${agent}`, live);
  kv.del(`web.lastTurnAt:default`); // the digest skip must be what stops it, not a recent turn
  let gateCalls = 0;
  const second = await runAgentHeartbeat({
    agent,
    kind: "hourly",
    useDigestSkip: true,
    gateFn: async () => {
      gateCalls++;
      return "WAKE should not run";
    },
    askFn: async () => "no",
    deliverFn: async () => {},
  });
  assert.equal(second.skipped, "digest-unchanged");
  assert.equal(gateCalls, 0);
});

test("runAgentHeartbeat: gate WAKE → ask → deliver", async () => {
  const { kv } = await import("./store.js");
  // Every executive is Robert now, so these ticks share his kv keys — clear them or a previous
  // test's delivery silences this one as a duplicate.
  kv.del("heartbeat.lastReply.robert");
  kv.del("web.lastTurnAt:default");
  const log: string[] = [];
  const result = await runAgentHeartbeat({
    agent: "robert",
    kind: "hourly",
    force: false,
    skipDigest: true,
    gateFn: async () => "WAKE free hour at 6 — suggest gym",
    askFn: async (agent, prompt) => {
      log.push(`ask:${agent}:${prompt.slice(0, 40)}`);
      return "Hey — you've got a free hour at 6. Gym?";
    },
    deliverFn: async (agent, reply) => {
      log.push(`deliver:${agent}:${reply}`);
    },
  });
  assert.equal(result.woke, true);
  assert.equal(result.delivered, true);
  assert.equal(result.skipped, null);
  assert.ok(log.some((l) => l.startsWith("ask:robert:")));
  assert.ok(log.some((l) => l.includes("Gym")));
});

test("runAgentHeartbeat: gate WAKE but executive NOOP → no deliver", async () => {
  const { kv } = await import("./store.js");
  kv.del("web.lastTurnAt:default");
  const result = await runAgentHeartbeat({
    agent: "robert",
    kind: "hourly",
    skipDigest: true,
    gateFn: async () => "WAKE maybe dig on ACM-58",
    askFn: async () => "NOOP",
    deliverFn: async () => {
      throw new Error("should not deliver");
    },
  });
  assert.equal(result.woke, true);
  assert.equal(result.delivered, false);
  assert.equal(result.skipped, "exec-noop");
});

test("bookend kinds ignore recent-turn skip (only hourly nags)", async () => {
  const { kv } = await import("./store.js");
  // Pretend the operator just talked to Robert in this workspace within the skip window.
  kv.set("web.lastTurnAt:w1", String(Date.now()));
  const target = { id: "w1", slug: "acme" };
  let asked = false;
  const morning = await runAgentHeartbeat({
    agent: "robert",
    kind: "morning",
    target,
    force: true,
    askFn: async () => {
      asked = true;
      return "morning brief for acme";
    },
    deliverFn: async () => {},
  });
  assert.equal(morning.skipped, null);
  assert.equal(morning.delivered, true);
  assert.equal(asked, true);

  // Hourly still respects recent-turn when not forced.
  const hourly = await runAgentHeartbeat({
    agent: "robert",
    kind: "hourly",
    target,
    force: false,
    skipDigest: true,
    gateFn: async () => "WAKE something",
    askFn: async () => "should not run",
    deliverFn: async () => {
      throw new Error("hourly should have skipped recent-turn");
    },
  });
  assert.equal(hourly.skipped, "recent-turn");
});

test("hourly heartbeat: identical reply to the last delivery is silenced; bookends are not", async () => {
  const { kv } = await import("./store.js");
  kv.del("heartbeat.lastReply.robert");
  kv.del("web.lastTurnAt:default");
  const tick = (askReply: string) =>
    runAgentHeartbeat({
      agent: "robert",
      kind: "hourly",
      skipDigest: true,
      gateFn: async () => "WAKE same angle again",
      askFn: async () => askReply,
      deliverFn: async () => {},
    });
  const first = await tick("Dig offer: ACM-8 blast radius — 30 min, want it?");
  assert.equal(first.delivered, true);
  const second = await tick("Dig offer: ACM-8 blast radius — 30 min, want it?");
  assert.equal(second.delivered, false);
  assert.equal(second.skipped, "duplicate-reply");
  const third = await tick("Fresh angle: PER-33 fallback path is untested.");
  assert.equal(third.delivered, true);

  // A repeated bookend still posts — scheduled briefs never self-silence.
  kv.set("heartbeat.lastReply.robert:w1", "morning brief for acme");
  const bookend = await runAgentHeartbeat({
    agent: "robert",
    kind: "morning",
    target: { id: "w1", slug: "acme" },
    force: true,
    askFn: async () => "morning brief for acme",
    deliverFn: async () => {},
  });
  assert.equal(bookend.delivered, true);
});

test("workspaceTargets: every workspace becomes a target", () => {
  const targets = workspaceTargets([
    { id: "w1", slug: "acme" },
    { id: "w2", slug: "globex" },
  ]);
  assert.deepEqual(targets, [
    { id: "w1", slug: "acme" },
    { id: "w2", slug: "globex" },
  ]);
  assert.deepEqual(workspaceTargets([]), []);
});

test("bookend brief is scoped to its workspace and delivered to that target", async () => {
  const target = { id: "w1", slug: "acme" };
  let prompt = "";
  let deliveredTo: string | undefined;
  const result = await runAgentHeartbeat({
    agent: "robert",
    kind: "morning",
    target,
    force: true,
    askFn: async (_a, p, t) => {
      prompt = p;
      assert.equal(t?.slug, "acme");
      return "here is acme's morning";
    },
    deliverFn: async (_a, _r, _k, t) => {
      deliveredTo = t?.slug;
    },
  });
  assert.equal(result.delivered, true);
  assert.match(prompt, /ONLY about the acme workspace/);
  assert.equal(deliveredTo, "acme");
});

test("standupSince: yesterday, but Monday reaches back to Friday", () => {
  assert.equal(standupSince(new Date(Date.UTC(2026, 6, 30, 13, 0))), "2026-07-29"); // Thu → Wed
  assert.equal(standupSince(new Date(Date.UTC(2026, 6, 27, 13, 0))), "2026-07-24"); // Mon → Fri
  assert.equal(standupSince(new Date(Date.UTC(2026, 6, 26, 13, 0))), "2026-07-24"); // Sun → Fri
});

test("standup prompt names the workspace, the window and the research trail", () => {
  const p = standupPrompt(
    { id: "w1", slug: "acme" },
    new Date(Date.UTC(2026, 6, 30, 13, 0))
  );
  assert.match(p, /DAILY STANDUP for the acme workspace/);
  assert.match(p, /2026-07-30/);
  assert.match(p, /2026-07-29/);
  assert.match(p, /gh pr list/);
  assert.match(p, /\/api\/workspaces\/w1\/sync/);
  assert.match(p, /never NOOP/);
});

test("standup runs Robert against its target and delivers there", async () => {
  const target = { id: "w1", slug: "globex" };
  let prompt = "";
  let kind = "";
  let deliveredTo: string | undefined;
  const result = await runAgentHeartbeat({
    agent: "robert",
    kind: "standup",
    target,
    force: true,
    askFn: async (_a, p) => {
      prompt = p;
      return "🗒️ **Standup · globex**\nYesterday: shipped ANA-12";
    },
    deliverFn: async (_a, _r, k, t) => {
      kind = k;
      deliveredTo = t?.slug;
    },
  });
  assert.equal(result.delivered, true);
  assert.equal(kind, "standup"); // never downgraded to an hourly proposal
  assert.match(prompt, /DAILY STANDUP for the globex workspace/);
  assert.equal(deliveredTo, "globex");
});

// ── Mail sweep ───────────────────────────────────────────────────────────────
// The loop is OFF in production while Robert is the only executive: it was Ada's, and Robert holds
// no Gmail MCP. What is still worth pinning is the part that was never hers and is the expensive
// part to get right — the throttle with its 5-minute grace, the duplicate-alert silence, the NOOP
// contract, the active-hours window. So these enable the flag explicitly and inject both sides;
// runMailSweep has no default asker any more, and reaching one throws on purpose.

test("mail sweep: quiet inbox is a NOOP — nothing delivered, throttle stamped", async () => {
  const { kv } = await import("./store.js");
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  kv.del("mailsweep.lastRunAt");
  kv.del("mailsweep.lastAlert");
  let delivered = 0;
  const r = await runMailSweep({
    force: true,
    askFn: async (p) => {
      assert.match(p, /UNREAD mail/);
      assert.match(p, /reply exactly NOOP/);
      return "NOOP";
    },
    deliverFn: async () => { delivered++; },
  });
  assert.deepEqual(r, { ran: true, alerted: false });
  assert.equal(delivered, 0);
  assert.ok(Number(kv.get("mailsweep.lastRunAt")) > 0);
});

test("mail sweep: important mail delivers once and seeds dedup for the next window", async () => {
  const { kv } = await import("./store.js");
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  kv.del("mailsweep.lastRunAt");
  kv.del("mailsweep.lastAlert");
  let sent = "";
  const r = await runMailSweep({
    force: true,
    askFn: async () => "Swiss Medical te pide una firma — hace 20 min",
    deliverFn: async (text) => { sent = text; },
  });
  assert.deepEqual(r, { ran: true, alerted: true });
  assert.match(sent, /Swiss Medical/);
  assert.match(kv.get("mailsweep.lastAlert") ?? "", /Swiss Medical/);

  // Next sweep's prompt carries the alert so she doesn't re-ping the same mail.
  let prompt = "";
  await runMailSweep({ force: true, askFn: async (p) => { prompt = p; return "NOOP"; }, deliverFn: async () => {} });
  assert.match(prompt, /do NOT alert for these same mails again/);
  assert.match(prompt, /Swiss Medical/);
});

test("mail sweep: prose non-report with trailing NOOP delivers nothing", async () => {
  const { kv } = await import("./store.js");
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  kv.del("mailsweep.lastRunAt");
  kv.del("mailsweep.lastAlert");
  let delivered = 0;
  const r = await runMailSweep({
    force: true,
    askFn: async () => "No new mail since last check.\n\nNOOP",
    deliverFn: async () => { delivered++; },
  });
  assert.deepEqual(r, { ran: true, alerted: false });
  assert.equal(delivered, 0);
});

test("mail sweep: identical alert to the last one is silenced", async () => {
  const { kv } = await import("./store.js");
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  kv.del("mailsweep.lastRunAt");
  kv.set("mailsweep.lastAlert", "GoDaddy — ROOLETA.COM expired 09/08 — worth a look this week");
  let delivered = 0;
  const r = await runMailSweep({
    force: true,
    askFn: async () => "GoDaddy — ROOLETA.COM expired 09/08 — worth a look this week",
    deliverFn: async () => { delivered++; },
  });
  assert.equal(r.skipped, "duplicate");
  assert.equal(delivered, 0);
});

test("mail sweep: throttled inside the window, runs again after it", async () => {
  const { kv } = await import("./store.js");
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  const base = new Date("2026-08-07T14:00:00");
  kv.set("mailsweep.lastRunAt", String(base.getTime()));
  const soon = await runMailSweep({ now: new Date(base.getTime() + 30 * 60_000), askFn: async () => "NOOP", deliverFn: async () => {} });
  assert.equal(soon.skipped, "throttled");
  const later = await runMailSweep({ now: new Date(base.getTime() + 61 * 60_000), askFn: async () => "NOOP", deliverFn: async () => {} });
  assert.deepEqual(later, { ran: true, alerted: false });
});

test("mail sweep: respects active hours unless forced", async () => {
  const { runMailSweep } = await import("./heartbeat.js");
  (await import("./config.js")).CONFIG.mailSweep.enabled = true;
  const night = new Date("2026-08-07T03:00:00");
  const r = await runMailSweep({ now: night, askFn: async () => "NOOP", deliverFn: async () => {} });
  assert.equal(r.skipped, "inactive-hours");
});

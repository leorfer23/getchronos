import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardedRefusal } from "./authz.js";

// The rules a request from an agent on ANOTHER computer must pass (HOSTS.md → `mc` on a host). The
// lookups are stubs: the rules are the thing under test, not the store.

const WS = { a: { id: "ws-a", slug: "acme" }, b: { id: "ws-b", slug: "globex" } };
const TOKENS: Record<string, { id: string; slug: string }> = { "tok-a": WS.a, "tok-b": WS.b };
type Row = { id: string; status: string; workspace_id: string | null; host_id: string };
const SESSIONS: Record<string, Row> = {
  "s-m2": { id: "s-m2", status: "live", workspace_id: "ws-a", host_id: "m2" },
  "s-m5": { id: "s-m5", status: "live", workspace_id: "ws-a", host_id: "m5" },
  "s-local": { id: "s-local", status: "live", workspace_id: "ws-a", host_id: "local" },
  "s-ended": { id: "s-ended", status: "ended", workspace_id: "ws-a", host_id: "m2" },
  "s-b": { id: "s-b", status: "live", workspace_id: "ws-b", host_id: "m2" },
};
const LEADS: Record<string, Row> = {
  "lead-m2": { id: "l1", status: "live", workspace_id: "ws-a", host_id: "m2" },
  "lead-local": { id: "l2", status: "live", workspace_id: "ws-a", host_id: "local" },
  "lead-dead": { id: "l3", status: "ended", workspace_id: "ws-a", host_id: "m2" },
};
let denied: Record<string, string[]> = {};
const look = {
  wsByToken: (t: string) => TOKENS[t],
  wsById: (id: string) => Object.values(WS).find((w) => w.id === id),
  leadByToken: (t: string) => LEADS[t] as any,
  session: (id: string) => SESSIONS[id] as any,
  deny: (h: string) => denied[h] ?? [],
};
const refuse = (host: string, c: Partial<{ wsToken: string; leadToken: string; sessionId: string }>) =>
  forwardedRefusal(host, { wsToken: c.wsToken ?? null, leadToken: c.leadToken ?? null, sessionId: c.sessionId ?? null }, look);

test("no credential is never loopback trust: a forwarded request without a token is refused", () => {
  denied = {};
  assert.equal(refuse("m2", {})?.status, 401);
  assert.equal(refuse("m2", { wsToken: "forged" })?.status, 401);
  assert.equal(refuse("m2", { leadToken: "lead-dead" })?.status, 401, "an ended Lead's burned token");
});

test("a workspace token alone passes; its own session on its own host passes", () => {
  denied = {};
  assert.equal(refuse("m2", { wsToken: "tok-a" }), null);
  assert.equal(refuse("m2", { wsToken: "tok-a", sessionId: "s-m2" }), null);
});

test("the named session must exist, be live, run on THIS host and be the token's workspace", () => {
  denied = {};
  assert.match(refuse("m2", { wsToken: "tok-a", sessionId: "nope" })!.error, /not live/);
  assert.match(refuse("m2", { wsToken: "tok-a", sessionId: "s-ended" })!.error, /not live/);
  assert.match(refuse("m2", { wsToken: "tok-a", sessionId: "s-m5" })!.error, /does not run on this host/, "m2 cannot speak for m5's terminal");
  assert.match(refuse("m2", { wsToken: "tok-a", sessionId: "s-local" })!.error, /does not run on this host/, "…nor for the brain's own");
  assert.match(refuse("m2", { wsToken: "tok-a", sessionId: "s-b" })!.error, /workspace token does not match/, "another workspace's terminal");
});

test("a Lead token only counts from the host that Lead runs on, and must agree with the workspace token", () => {
  denied = {};
  assert.equal(refuse("m2", { leadToken: "lead-m2" }), null);
  assert.equal(refuse("m2", { leadToken: "lead-m2", sessionId: "s-m2" }), null, "the Lead's workspace stands in for a token");
  assert.equal(refuse("m2", { leadToken: "lead-local" })?.status, 403, "a Lead token seen from another machine was copied off the brain");
  assert.equal(refuse("m2", { leadToken: "lead-m2", wsToken: "tok-b" })?.status, 403);
});

test("the brain's policy for that host (lock #1) refuses a denied workspace, by id or slug", () => {
  denied = { m2: ["acme"] };
  assert.match(refuse("m2", { wsToken: "tok-a" })!.error, /acme is not allowed on this host/);
  assert.equal(refuse("m5", { wsToken: "tok-a" }), null, "the policy is per host");
  denied = { m2: ["ws-a"] };
  assert.equal(refuse("m2", { leadToken: "lead-m2" })?.status, 403, "reached through a Lead's workspace too");
  denied = {};
});

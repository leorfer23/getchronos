import { test } from "node:test";
import assert from "node:assert/strict";
import { redactConnectorConfig, publicTrigger, mergeConnectorConfigWithSentinel, CRED_MASK } from "./redact.js";

test("redactConnectorConfig masks credential-shaped keys, keeps the rest", () => {
  const raw = JSON.stringify({ token: "pk_live_abc123", list_id: "901234", base_url: "https://x.atlassian.net" });
  const out = JSON.parse(redactConnectorConfig(raw) as string);
  assert.equal(out.token, "••••••••");
  assert.equal(out.list_id, "901234");
  assert.equal(out.base_url, "https://x.atlassian.net");
});

test("redactConnectorConfig masks jira-style api_token and email stays", () => {
  const raw = JSON.stringify({ email: "a@b.com", api_token: "secretvalue" });
  const out = JSON.parse(redactConnectorConfig(raw) as string);
  assert.equal(out.api_token, "••••••••");
  assert.equal(out.email, "a@b.com");
});

test("redactConnectorConfig passes through null/empty/non-string unchanged", () => {
  assert.equal(redactConnectorConfig(null), null);
  assert.equal(redactConnectorConfig(""), "");
  assert.equal(redactConnectorConfig(undefined), undefined);
});

test("redactConnectorConfig passes through unparseable JSON unchanged (never throws)", () => {
  assert.equal(redactConnectorConfig("not json"), "not json");
});

test("publicTrigger strips token and hook_url for non-admin callers", () => {
  const t = { id: "t1", name: "x", token: "deadbeef", hook_url: "http://localhost/api/triggers/hook/deadbeef" };
  const out: any = publicTrigger(t, false);
  assert.equal(out.token, undefined);
  assert.equal(out.hook_url, undefined);
  assert.equal(out.id, "t1");
  assert.equal(out.name, "x");
});

test("publicTrigger keeps token and hook_url for admin callers", () => {
  const t = { id: "t1", token: "deadbeef", hook_url: "http://localhost/api/triggers/hook/deadbeef" };
  const out = publicTrigger(t, true);
  assert.equal(out.token, "deadbeef");
  assert.equal(out.hook_url, "http://localhost/api/triggers/hook/deadbeef");
});

test("publicTrigger passes through a trigger with no token unchanged", () => {
  const t = { id: "t1", name: "cron-job", token: null };
  const out = publicTrigger(t, false);
  assert.equal(out.id, "t1");
  assert.equal(out.token, undefined);
});

test("mergeConnectorConfigWithSentinel preserves stored secret when patch contains mask", () => {
  const stored = JSON.stringify({ token: "pk_live_abc123", list_id: "901234" });
  const patch = { token: CRED_MASK, list_id: "901234" };
  const result = JSON.parse(mergeConnectorConfigWithSentinel(stored, patch) as string);
  assert.equal(result.token, "pk_live_abc123");
  assert.equal(result.list_id, "901234");
});

test("mergeConnectorConfigWithSentinel overwrites with new explicit secret value", () => {
  const stored = JSON.stringify({ token: "pk_live_abc123", list_id: "901234" });
  const patch = { token: "pk_live_xyz789", list_id: "901234" };
  const result = JSON.parse(mergeConnectorConfigWithSentinel(stored, patch) as string);
  assert.equal(result.token, "pk_live_xyz789");
  assert.equal(result.list_id, "901234");
});

test("mergeConnectorConfigWithSentinel preserves jira api_token when masked", () => {
  const stored = JSON.stringify({ email: "a@b.com", api_token: "secrettoken123" });
  const patch = { email: "a@b.com", api_token: CRED_MASK };
  const result = JSON.parse(mergeConnectorConfigWithSentinel(stored, patch) as string);
  assert.equal(result.api_token, "secrettoken123");
  assert.equal(result.email, "a@b.com");
});

test("mergeConnectorConfigWithSentinel handles empty patch", () => {
  const stored = JSON.stringify({ token: "pk_live_abc123" });
  const patch = {};
  const result = mergeConnectorConfigWithSentinel(stored, patch);
  assert.equal(result, null);
});

test("mergeConnectorConfigWithSentinel handles null stored config", () => {
  const patch = { token: "pk_live_abc123", list_id: "901234" };
  const result = JSON.parse(mergeConnectorConfigWithSentinel(null, patch) as string);
  assert.equal(result.token, "pk_live_abc123");
  assert.equal(result.list_id, "901234");
});

test("mergeConnectorConfigWithSentinel handles unparseable stored config gracefully", () => {
  const patch = { token: "pk_live_abc123" };
  const result = JSON.parse(mergeConnectorConfigWithSentinel("not json", patch) as string);
  assert.equal(result.token, "pk_live_abc123");
});

test("mergeConnectorConfigWithSentinel handles edge case where stored is null and patch has values", () => {
  const patch = { token: "pk_live_abc123", list_id: "901234" };
  const result = JSON.parse(mergeConnectorConfigWithSentinel(null, patch) as string);
  assert.equal(result.token, "pk_live_abc123");
  assert.equal(result.list_id, "901234");
});

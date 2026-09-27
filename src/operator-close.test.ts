import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { operatorMayCloseTerminal, tokenOk } from "./authz.js";

function fakeReq(headers: Record<string, string | undefined>) {
  return {
    get(name: string) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? headers[key] : undefined;
    },
  } as any;
}

function fakeRes() {
  const out: { statusCode?: number; body?: any } = {};
  return {
    out,
    status(c: number) {
      out.statusCode = c;
      return this;
    },
    json(b: any) {
      out.body = b;
      return this;
    },
  } as any;
}

test("operatorMayCloseTerminal: Desk/Telegram shape (admin + x-mc-operator) is allowed", () => {
  assert.ok(tokenOk(CONFIG.adminToken, CONFIG.adminToken), "test needs a configured admin token");
  const res = fakeRes();
  assert.equal(
    operatorMayCloseTerminal(fakeReq({ "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1" }), res),
    true,
  );
  assert.equal(res.out.statusCode, undefined);
});

test("operatorMayCloseTerminal: admin alone is not enough", () => {
  const res = fakeRes();
  assert.equal(operatorMayCloseTerminal(fakeReq({ "x-mc-admin": CONFIG.adminToken }), res), false);
  assert.equal(res.out.statusCode, 403);
  assert.match(String(res.out.body?.error), /operator's hand/);
});

test("operatorMayCloseTerminal: Robert / agent header is refused even with operator flag", () => {
  const res = fakeRes();
  assert.equal(
    operatorMayCloseTerminal(
      fakeReq({ "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1", "x-mc-agent": "robert" }),
      res,
    ),
    false,
  );
  assert.match(String(res.out.body?.error), /agents may not/);
});

test("operatorMayCloseTerminal: Lead credential is refused", () => {
  const res = fakeRes();
  assert.equal(
    operatorMayCloseTerminal(
      fakeReq({ "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1", "x-mc-lead": "any" }),
      res,
    ),
    false,
  );
  assert.match(String(res.out.body?.error), /agents may not/);
});

test("operatorMayCloseTerminal: session-scoped agent is refused", () => {
  const res = fakeRes();
  assert.equal(
    operatorMayCloseTerminal(
      fakeReq({ "x-mc-admin": CONFIG.adminToken, "x-mc-operator": "1", "x-mc-session": "abc" }),
      res,
    ),
    false,
  );
  assert.match(String(res.out.body?.error), /agents may not/);
});

test("operatorMayCloseTerminal: no admin is refused", () => {
  const res = fakeRes();
  assert.equal(operatorMayCloseTerminal(fakeReq({ "x-mc-operator": "1" }), res), false);
  assert.equal(res.out.statusCode, 403);
});

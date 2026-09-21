import assert from "node:assert/strict";
import { describe, test } from "node:test";

// CONFIG snapshots env at import — pin the admin token before pulling agent/config in.
process.env.CHRONOS_ADMIN_TOKEN = "per10-test-admin-token";

const { CONFIG } = await import("../config.js");
const { autoExecProposal, dismissProposal, execProposal, tierProposal } = await import("./agent.js");
type Proposal = import("./agent.js").Proposal;

type ApiHit = { url: string; method: string; admin: string | undefined; body: string | undefined };
type TgMsg = { text: string; reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } };

function stubWire(opts?: {
  api?: (hit: ApiHit, n: number) => { status: number; json: unknown };
}) {
  const apiHits: ApiHit[] = [];
  const tgMsgs: TgMsg[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      const payload = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/sendMessage")) {
        tgMsgs.push({ text: payload.text ?? "", reply_markup: payload.reply_markup });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
      } as Response;
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const hit: ApiHit = {
      url,
      method: String(init?.method ?? "GET").toUpperCase(),
      admin: headers["x-mc-admin"],
      body: init?.body != null ? String(init.body) : undefined,
    };
    apiHits.push(hit);
    const r = opts?.api?.(hit, apiHits.length) ?? { status: 200, json: { key: "PER-99" } };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
  return {
    apiHits,
    tgMsgs,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const safeTicket = (): Proposal => ({
  label: "New ticket",
  method: "POST",
  path: "/api/tickets",
  body: { workspace_id: "w1", title: "x" },
});

const riskyKill = (): Proposal => ({
  label: "Kill run",
  method: "POST",
  path: "/api/runs/r1/kill",
});

// These tests share globalThis.fetch — must not run concurrent with each other.
describe("propose-exec glue", { concurrency: false }, () => {
  test("safe single-item proposal auto-executes with ⚡ receipt and no pending card", async () => {
    const wire = stubWire({ api: () => ({ status: 200, json: { key: "PER-42" } }) });
    try {
      await autoExecProposal(safeTicket(), 42);
      assert.equal(wire.apiHits.length, 1);
      assert.match(wire.apiHits[0].url, /\/api\/tickets$/);
      assert.equal(wire.apiHits[0].method, "POST");
      assert.equal(wire.tgMsgs.length, 1);
      assert.match(wire.tgMsgs[0].text, /⚡ New ticket/);
      assert.match(wire.tgMsgs[0].text, /PER-42/);
      assert.equal(wire.tgMsgs[0].reply_markup, undefined, "safe tier must not show a confirm card");
      // No pending entry: a follow-up exec with a made-up id finds nothing to run. PER-21 split the
      // old blanket "proposal expired" into ttl / cap / restart reasons; an id that was never stored
      // has no tombstone, so it resolves to the restart wording.
      await execProposal("deadbeef", 42);
      assert.match(wire.tgMsgs.at(-1)!.text, /proposal gone/);
      assert.equal(dismissProposal("deadbeef"), false);
    } finally {
      wire.restore();
    }
  });

  test("risky proposal tiers to putProposal+card and does NOT call the admin API", async () => {
    const wire = stubWire();
    try {
      const tier = await tierProposal(riskyKill(), 7, 99);
      assert.equal(tier, "card");
      assert.equal(wire.apiHits.length, 0, "risky tier must not fire until the operator taps ✅");
      assert.equal(wire.tgMsgs.length, 1);
      assert.match(wire.tgMsgs[0].text, /🅿️/);
      assert.match(wire.tgMsgs[0].text, /Kill run/);
      const rows = wire.tgMsgs[0].reply_markup?.inline_keyboard ?? [];
      const execBtn = rows.flat().find((b) => b.callback_data?.startsWith("px.x."));
      assert.ok(execBtn, "confirm card must include Execute");
      const pid = execBtn!.callback_data.slice("px.x.".length);
      assert.equal(pid.length, 8);
      // Pending was created — dismiss removes it (and proves it existed).
      assert.equal(dismissProposal(pid), true);
    } finally {
      wire.restore();
    }
  });

  test("batch stops on first failure and receipt lists only items that succeeded", async () => {
    const wire = stubWire({
      api: (_hit, n) => {
        if (n === 1) return { status: 200, json: { key: "T-1" } };
        if (n === 2) return { status: 500, json: { error: "boom" } };
        return { status: 200, json: { key: "T-3" } };
      },
    });
    try {
      await autoExecProposal(
        {
          label: "create 3",
          batch: [
            { method: "POST", path: "/api/tickets", body: { title: "a" } },
            { method: "POST", path: "/api/tickets", body: { title: "b" } },
            { method: "POST", path: "/api/tickets", body: { title: "c" } },
          ],
        },
        11,
      );
      assert.equal(wire.apiHits.length, 2, "must not fire item 3 after item 2 fails");
      assert.equal(wire.tgMsgs.length, 1);
      assert.match(wire.tgMsgs[0].text, /⚡ created T-1/);
      assert.match(wire.tgMsgs[0].text, /❌ failed on item 2: boom/);
      assert.doesNotMatch(wire.tgMsgs[0].text, /T-3/);
    } finally {
      wire.restore();
    }
  });

  test("fire sends x-mc-admin on every admin-API request", async () => {
    const wire = stubWire({
      api: (_hit, n) => ({ status: 200, json: { key: `K-${n}` } }),
    });
    try {
      await autoExecProposal(
        {
          label: "two notes",
          batch: [
            { method: "POST", path: "/api/tickets/t1/note", body: { text: "a" } },
            { method: "POST", path: "/api/tickets/t1/note", body: { text: "b" } },
          ],
        },
        3,
      );
      assert.equal(wire.apiHits.length, 2);
      for (const hit of wire.apiHits) {
        assert.equal(hit.admin, CONFIG.adminToken);
        assert.equal(hit.admin, "per10-test-admin-token");
      }
      assert.match(wire.tgMsgs[0].text, /⚡ created K-1, K-2/);
    } finally {
      wire.restore();
    }
  });

  test("tierProposal safe path auto-fires (same fork runAgent uses)", async () => {
    const wire = stubWire({ api: () => ({ status: 200, json: { key: "SAFE-1" } }) });
    try {
      const tier = await tierProposal(safeTicket(), 5);
      assert.equal(tier, "auto");
      assert.equal(wire.apiHits.length, 1);
      assert.equal(wire.apiHits[0].admin, CONFIG.adminToken);
      assert.match(wire.tgMsgs[0].text, /⚡ New ticket/);
      assert.equal(wire.tgMsgs[0].reply_markup, undefined);
    } finally {
      wire.restore();
    }
  });
});

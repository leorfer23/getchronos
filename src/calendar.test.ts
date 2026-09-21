import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, parseICS, gwsEnv, fetchIcsSafely } from "./calendar.js";

// Public IP literals (RFC5737 TEST-NET-3, docs range) so assertSafeUrl's guard passes without a
// real DNS lookup — fetch itself is mocked below, no network is actually touched.
const PUBLIC_URL = "http://203.0.113.10/cal.ics";
const PUBLIC_URL_2 = "http://203.0.113.20/cal.ics";

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = orig; });
}

test("assertSafeUrl rejects loopback and link-local/metadata IP literals", async () => {
  await assert.rejects(() => assertSafeUrl("http://127.0.0.1/cal.ics"));
  await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(() => assertSafeUrl("http://192.168.1.5:8080/cal.ics"));
});

test("assertSafeUrl rejects non-http(s) schemes and malformed URLs", async () => {
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"));
  await assert.rejects(() => assertSafeUrl("not a url"));
  await assert.rejects(() => assertSafeUrl(null));
});

test("assertSafeUrl allows a public IP literal", async () => {
  await assert.doesNotReject(() => assertSafeUrl("https://8.8.8.8/cal.ics"));
});

test("parseICS still parses a basic VEVENT (unaffected by SSRF guard)", () => {
  const ics = ["BEGIN:VEVENT", "SUMMARY:Standup", "DTSTART:20260101T090000Z", "DTEND:20260101T093000Z", "END:VEVENT"].join("\n");
  const [ev] = parseICS(ics);
  assert.equal(ev.title, "Standup");
  assert.equal(ev.start, "2026-01-01T09:00:00Z");
});

test("gwsEnv excludes daemon secrets to prevent multi-tenant token leak", () => {
  process.env.CHRONOS_TEST_LEAK = "leaked-secret";
  const env = gwsEnv(null);
  assert.equal(env.CHRONOS_TEST_LEAK, undefined);
  delete process.env.CHRONOS_TEST_LEAK;
});

test("gwsEnv allows safe vars (PATH, LANG, TZ, HOME)", () => {
  const env = gwsEnv(null);
  assert.equal(env.PATH, process.env.PATH);
  assert.equal(env.LANG, process.env.LANG);
  assert.equal(env.TZ, process.env.TZ);
});

test("gwsEnv overrides HOME when configDir provided", () => {
  const env = gwsEnv("/custom/home");
  assert.equal(env.HOME, "/custom/home");
});

test("gwsEnv uses daemon HOME when no configDir", () => {
  const env = gwsEnv(null);
  assert.equal(env.HOME, process.env.HOME);
});

test("fetchIcsSafely follows a redirect to a safe URL and returns the final body", async () => {
  const calls: string[] = [];
  const ics = "BEGIN:VEVENT\nSUMMARY:Hi\nEND:VEVENT";
  await withMockFetch(async (input: any) => {
    calls.push(String(input));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: PUBLIC_URL_2 } });
    return new Response(ics, { status: 200 });
  }, async () => {
    const text = await fetchIcsSafely(PUBLIC_URL, "test-cal");
    assert.equal(text, ics);
    assert.deepEqual(calls, [PUBLIC_URL, PUBLIC_URL_2]);
  });
});

test("fetchIcsSafely re-validates each redirect hop and rejects one that points at a blocked address", async () => {
  await withMockFetch(async () =>
    new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
    async () => {
      await assert.rejects(() => fetchIcsSafely(PUBLIC_URL, "test-cal"), /non-routable/);
    });
});

test("fetchIcsSafely gives up after too many redirect hops", async () => {
  let n = 0;
  await withMockFetch(async () => {
    n++;
    return new Response(null, { status: 302, headers: { location: `http://203.0.113.${10 + n}/cal.ics` } });
  }, async () => {
    await assert.rejects(() => fetchIcsSafely(PUBLIC_URL, "test-cal"), /exceeded .* redirects/);
  });
});

test("fetchIcsSafely passes redirect:manual and an AbortSignal to fetch", async () => {
  let opts: any;
  await withMockFetch(async (_input: any, init: any) => {
    opts = init;
    return new Response("BEGIN:VEVENT\nEND:VEVENT", { status: 200 });
  }, async () => {
    await fetchIcsSafely(PUBLIC_URL, "test-cal");
  });
  assert.equal(opts.redirect, "manual");
  assert.ok(opts.signal instanceof AbortSignal);
});

test("fetchIcsSafely caps response body size instead of buffering unbounded", async () => {
  const chunk = new Uint8Array(6 * 1024 * 1024); // two of these exceed the 10MB cap
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  });
  await withMockFetch(async () => new Response(stream, { status: 200 }), async () => {
    await assert.rejects(() => fetchIcsSafely(PUBLIC_URL, "test-cal"), /exceeded .* bytes/);
  });
});

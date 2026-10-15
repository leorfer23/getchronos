import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dns from "node:dns/promises";
import net from "node:net";
import { CONFIG } from "./config.js";
import { calendars, calEvents } from "./store.js";
import { isBlockedIp } from "./net-guard.js";
import type { Calendar, CalEvent } from "./types.js";

const pexec = promisify(execFile);
type ParsedEvent = Omit<CalEvent, "id" | "calendar_id">;

// SSRF guard: ics_url is operator-supplied but resolved/fetched by the unsandboxed daemon, so a
// URL pointing at loopback/RFC1918/link-local (cloud metadata) must be rejected before fetch().
export async function assertSafeUrl(raw: string | null | undefined): Promise<void> {
  let u: URL;
  try { u = new URL(raw || ""); } catch { throw new Error("ics_url is not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("ics_url must be http or https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length) throw new Error("ics_url host did not resolve");
  if (addrs.some(isBlockedIp)) throw new Error(`ics_url resolves to a non-routable address (${host})`);
}

const titleIgnored = (t: string) => CONFIG.calIgnoreTitles.some((p) => (t || "").toLowerCase().includes(p));
export const calIgnored = (name: string) => CONFIG.calIgnoreCals.some((p) => (name || "").toLowerCase().includes(p));
const keep = (e: ParsedEvent) => !!e.start && !titleIgnored(e.title);

// Minimal env for gws CLI: PATH (find libs), LANG/TZ (locale), HOME (overridden for config isolation).
// Excludes daemon secrets that would leak multi-tenant tokens.
export function gwsEnv(configDir: string | null): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.TZ) env.TZ = process.env.TZ;
  if (configDir) {
    env.HOME = configDir;
  } else if (process.env.HOME) {
    env.HOME = process.env.HOME;
  }
  return env;
}

// Parse an ICS datetime/date value (+ optional params like TZID/VALUE=DATE) to ISO + all-day flag.
function parseDt(rawKey: string, value: string): { iso: string; allDay: boolean } {
  const isDate = /VALUE=DATE(;|:|$)/i.test(rawKey) || /^\d{8}$/.test(value);
  if (isDate && /^\d{8}$/.test(value)) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`;
    return { iso, allDay: true };
  }
  // 20260626T130000Z  or  20260626T130000 (floating/TZID local)
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const [, Y, Mo, D, h, mi, s, z] = m;
    return { iso: `${Y}-${Mo}-${D}T${h}:${mi}:${s}${z ? "Z" : ""}`, allDay: false };
  }
  return { iso: value, allDay: false };
}

// Minimal but tolerant ICS parser: unfold continuation lines, walk VEVENT blocks.
export function parseICS(text: string): ParsedEvent[] {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  const out: ParsedEvent[] = [];
  let cur: Partial<ParsedEvent> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = { all_day: 0 }; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.title && cur.start) out.push(cur as ParsedEvent);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    const rawKey = line.slice(0, ci);
    const value = line.slice(ci + 1);
    const key = rawKey.split(";")[0].toUpperCase();
    if (key === "SUMMARY") cur.title = unescapeIcs(value);
    else if (key === "UID") cur.uid = value;
    else if (key === "LOCATION") cur.location = unescapeIcs(value);
    else if (key === "DTSTART") { const d = parseDt(rawKey, value); cur.start = d.iso; cur.all_day = d.allDay ? 1 : 0; }
    else if (key === "DTEND") { const d = parseDt(rawKey, value); cur.end = d.iso; }
  }
  return out;
}

function unescapeIcs(s: string): string {
  return s.replace(/\\n/gi, " ").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

// ICS fetch is followed manually (not left at fetch's redirect:"follow" default) so every hop is
// re-validated by assertSafeUrl before it's requested — a 302 to a blocked address must be caught
// on the hop, not just the original URL. Timeout mirrors exec.ts's execFileTimed default; byte cap
// mirrors the maxBuffer idiom used for the pexec-based refreshLocal/refreshGws calls below.
const ICS_MAX_REDIRECTS = 5;
const ICS_FETCH_TIMEOUT_MS = 15_000;
const ICS_MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function fetchIcsSafely(startUrl: string | null, calName: string): Promise<string> {
  let url = startUrl || "";
  for (let hop = 0; hop <= ICS_MAX_REDIRECTS; hop++) {
    await assertSafeUrl(url);
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(ICS_FETCH_TIMEOUT_MS) });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) throw new Error(`calendar fetch redirect ${r.status} with no Location header for ${calName}`);
      url = new URL(loc, url).toString();
      continue;
    }
    if (!r.ok) throw new Error(`calendar fetch ${r.status} for ${calName}`);
    return readCapped(r.body, ICS_MAX_BYTES);
  }
  throw new Error(`calendar fetch exceeded ${ICS_MAX_REDIRECTS} redirects for ${calName}`);
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`calendar response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function refresh(cal: Calendar): Promise<{ events: number }> {
  if (cal.source === "local") return refreshLocal(cal);
  if (cal.source === "gws") return refreshGws(cal);
  const text = await fetchIcsSafely(cal.ics_url, cal.name);
  const evs = parseICS(text).filter(keep);
  calEvents.replace(cal.id, evs);
  calendars.markSync(cal.id);
  return { events: evs.length };
}

// Pull from the local macOS Calendar store via `ical` (EventKit). Reads whatever the Mac syncs —
// Google personal/Workspace, iCloud, Exchange — no OAuth/ICS/admin. cal.account = Mac calendar
// name to filter to (empty = all calendars merged).
async function refreshLocal(cal: Calendar): Promise<{ events: number }> {
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  const args = ["export", "-f", from, "-t", to, "--format", "json"];
  if (cal.account) args.push("-c", cal.account);
  const { stdout } = await pexec(CONFIG.icalBin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
  const items: any[] = JSON.parse(stdout || "[]");
  const evs: ParsedEvent[] = items
    .map((it) => ({
      uid: it.id ?? null,
      title: it.title || "(no title)",
      start: it.start_date,
      end: it.end_date || null,
      all_day: it.all_day ? 1 : 0,
      location: it.location ?? null,
    }))
    .filter(keep);
  calEvents.replace(cal.id, evs);
  calendars.markSync(cal.id);
  return { events: evs.length };
}

// Ingest pre-fetched local calendars+events, pushed by a context that HAS Calendar TCC access.
// Written back when the launchd daemon could not read EventKit itself; it can now — refreshLocal
// above shells out to the same `ical` binary on the 15-min tick, and that is what actually keeps
// cal_events current. Kept as the fallback for a host where TCC is denied. No caller today.
export function ingestLocal(payload: { workspace_id?: string | null; calendars?: Array<{ name?: string; account: string; color?: string | null; events?: any[] }> }): Array<{ name: string; events: number }> {
  const out: Array<{ name: string; events: number }> = [];
  for (const c of payload.calendars ?? []) {
    if (calIgnored(c.account || c.name || "")) continue; // skip noisy calendars (holidays, birthdays)
    let cal = calendars.list().find((x) => x.source === "local" && x.account === c.account);
    if (!cal) cal = calendars.create({ name: c.name || c.account, source: "local", account: c.account, color: c.color ?? null, workspace_id: payload.workspace_id ?? null });
    const evs: ParsedEvent[] = (c.events ?? [])
      .map((e: any) => ({ uid: e.uid ?? null, title: e.title || "(no title)", start: e.start, end: e.end || null, all_day: e.all_day ? 1 : 0, location: e.location ?? null }))
      .filter(keep);
    calEvents.replace(cal.id, evs);
    calendars.markSync(cal.id);
    out.push({ name: cal.name, events: evs.length });
  }
  return out;
}

// One-shot: read every Mac calendar and create a local source per calendar (color-coded).
export async function importLocalCalendars(workspaceId?: string | null): Promise<Array<{ name: string; events?: number; error?: string }>> {
  const { stdout } = await pexec(CONFIG.icalBin, ["calendars", "-o", "json"], { maxBuffer: 16 * 1024 * 1024, timeout: 20000 });
  const macCals: any[] = JSON.parse(stdout || "[]");
  const existing = new Set(calendars.list().filter((c) => c.source === "local").map((c) => c.account));
  const out: Array<{ name: string; events?: number; error?: string }> = [];
  for (const mc of macCals) {
    if (existing.has(mc.title) || calIgnored(mc.title)) continue;
    const cal = calendars.create({ name: mc.title, source: "local", account: mc.title, color: mc.color ?? null, workspace_id: workspaceId ?? null });
    try {
      const r = await refresh(cal);
      out.push({ name: mc.title, events: r.events });
    } catch (e: any) {
      out.push({ name: mc.title, error: String(e.message ?? e) });
    }
  }
  return out;
}

// Pull via the gws CLI (Google Workspace), isolating each account's credentials in its own
// XDG_CONFIG_HOME so multiple Workspace accounts don't collide (mirrors the per-workspace wall).
async function refreshGws(cal: Calendar): Promise<{ events: number }> {
  const timeMin = new Date(Date.now() - 7 * 86400000).toISOString();
  const timeMax = new Date(Date.now() + 90 * 86400000).toISOString();
  const params = JSON.stringify({
    calendarId: cal.account || "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 500,
  });
  // gws stores credentials under $HOME/.config/gws — override HOME to isolate each account.
  const env = gwsEnv(cal.config_dir);
  const { stdout } = await pexec(
    CONFIG.gwsBin,
    ["calendar", "events", "list", "--params", params, "--format", "json"],
    { env, maxBuffer: 64 * 1024 * 1024, timeout: 30000 }
  );
  const data = JSON.parse(stdout);
  const items: any[] = data.items ?? [];
  const evs: ParsedEvent[] = items
    .map((it) => {
      const start = it.start?.dateTime || it.start?.date;
      const end = it.end?.dateTime || it.end?.date || null;
      const allDay = !!(it.start?.date && !it.start?.dateTime);
      return { uid: it.id ?? null, title: it.summary || "(no title)", start, end, all_day: allDay ? 1 : 0, location: it.location ?? null };
    })
    .filter(keep);
  calEvents.replace(cal.id, evs);
  calendars.markSync(cal.id);
  return { events: evs.length };
}

export async function refreshAll(): Promise<void> {
  for (const c of calendars.list()) {
    if (!c.enabled) continue;
    try {
      const { events } = await refresh(c);
      console.log(`[calendar] ${c.name}: ${events} events`);
    } catch (e: any) {
      console.error(`[calendar] ${c.name} refresh failed:`, e.message ?? e);
    }
  }
}

// Refresh on boot + every 15 min.
export function startCalendar(): void {
  if (!calendars.list().length) return;
  refreshAll();
  setInterval(refreshAll, 15 * 60 * 1000).unref?.();
}

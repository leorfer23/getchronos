/**
 * `mc` writes that can wait for the brain (HOSTS.md → Reconnect and restarts).
 *
 * A host's agents keep working while the brain is away — a closed lid, a flaky tunnel — and most of
 * what they tell the brain is status: the card's state, a progress counter, a hook event, a fact
 * learned, a parked thought. Losing those to a 503 leaves the Desk wrong for hours after the brain is
 * back. So the forwarder puts them here, answers 202, and they are replayed in order once the link is
 * online again. Anything that needs an answer (an ask, a heavy slot, a read) is never queued.
 *
 * One file per request under `~/.chronos-host/outbox/`, named by a monotonic sequence number, so the
 * order survives a host restart and dropping the oldest is one unlink. An entry keeps the request's
 * own headers minus the ones the brain would drop anyway (FORWARD_STRIP_HEADERS): what is left is the
 * workspace or Lead token and the session, which is how the brain still attributes a late write to
 * the terminal that made it. Files are 0600, and the whole host home is sealed from every agent's
 * sandbox (config.ts → sandbox.sealed) — agents run as this same user, so the mode alone would not.
 */
import fs from "node:fs";
import path from "node:path";
import { FORWARD_STRIP_HEADERS } from "../hostlink/wire.js";
import type { ApiRequest, ApiResponse } from "./link.js";

/**
 * What may be queued: method + path, nothing else. Each is a status-type write whose meaning does not
 * depend on WHEN it lands, and whose loss is worse than its lateness. Not here, on purpose:
 * `/usage/report` (a statusline reading, stale the moment a newer one exists), `/asks` (someone must
 * answer), `/machine/slots` (the forwarder grants those locally), and anything that is not a POST.
 */
const QUEUEABLE: Array<[method: string, path: RegExp]> = [
  ["POST", /^\/api\/sessions\/[^/]+\/(?:hook|status|progress)$/], // card events, `mc state`, `mc progress`
  ["POST", /^\/api\/agents\/[^/]+\/report$/], // `mc state` from a headless run
  ["POST", /^\/api\/runs\/[^/]+\/steps\/\d+$/], // `mc step start|done|skip`
  ["POST", /^\/api\/workspaces\/[^/]+\/(?:learn|remember|jots)$/], // `mc learn`, `mc remember`, `mc pad add`
  ["POST", /^\/api\/jots\/[^/]+\/append$/], // `mc pad append`
];

export function queueable(method: string, url: string): boolean {
  const p = url.split("?")[0];
  return QUEUEABLE.some(([m, re]) => m === method.toUpperCase() && re.test(p));
}

export type OutboxOptions = {
  maxItems?: number;
  maxBytes?: number;
  /** A brain that keeps answering 5xx to one entry is refusing it, not down: dropped after this many. */
  maxServerErrors?: number;
  log?: (line: string) => void;
};

export type Queued = ApiRequest & { at: number };
export type DrainResult = { sent: number; dropped: number; left: number };

export class Outbox {
  private names: string[] = [];
  private sizes = new Map<string, number>();
  private total = 0;
  private next = 1;
  private draining: Promise<DrainResult> | null = null;
  private serverErrors = new Map<string, number>();
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private readonly log: (line: string) => void;

  constructor(readonly dir: string, private readonly o: OutboxOptions = {}) {
    this.maxItems = o.maxItems ?? 2000;
    this.maxBytes = o.maxBytes ?? 16 * 1024 * 1024;
    this.log = o.log ?? ((s) => console.log(`[host] ${s}`));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // What a previous run left behind is still owed to the brain: pick it up in order. A `.tmp` is a
    // write that never finished — its caller never got the 202, so nothing is owed for it.
    const files = fs.readdirSync(dir);
    for (const f of files.filter((f) => f.endsWith(".tmp"))) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    for (const f of files.filter((f) => /^\d{16}\.json$/.test(f)).sort()) {
      try {
        const n = fs.statSync(path.join(dir, f)).size;
        this.names.push(f);
        this.sizes.set(f, n);
        this.total += n;
      } catch {}
    }
    if (this.names.length) this.next = Number(this.names[this.names.length - 1].slice(0, 16)) + 1;
  }

  get size(): number { return this.names.length; }
  get bytes(): number { return this.total; }

  /** Keep one request for later. false = it alone is over the byte cap, or the disk refused (the caller answers as before). */
  put(req: ApiRequest): boolean {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (!FORWARD_STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    const data = Buffer.from(JSON.stringify({ ...req, headers, at: Date.now() } satisfies Queued));
    if (data.length > this.maxBytes) return false;
    const name = String(this.next++).padStart(16, "0") + ".json";
    const file = path.join(this.dir, name);
    try {
      // tmp + rename: a crash mid-write must not leave a half entry that replays as garbage.
      fs.writeFileSync(file + ".tmp", data, { mode: 0o600 });
      fs.renameSync(file + ".tmp", file);
    } catch (e: any) {
      this.log(`outbox write failed (${e?.message ?? e}) — answering this mc call as unreachable`);
      return false;
    }
    this.names.push(name);
    this.sizes.set(name, data.length);
    this.total += data.length;
    // Oldest go first: for status the newest write is the one that matters.
    let dropped = 0;
    while (this.names.length > this.maxItems || this.total > this.maxBytes) { this.remove(this.names[0]); dropped++; }
    if (dropped) this.log(`outbox full (${this.maxItems} writes / ${Math.round(this.maxBytes / 1048576)} MB) — dropped the ${dropped} oldest queued mc write${dropped === 1 ? "" : "s"}`);
    return true;
  }

  /**
   * Replay in FIFO order through `send` (HostLink.api). 2xx: delivered. 4xx: the brain refuses it
   * (the session ended, the token was rotated) and it never will accept it — dropped and logged. 503,
   * 408, 429 or a throw: stop and keep everything for the next try. Other 5xx count against the entry.
   * One drain at a time; a second caller gets the running one.
   *
   * At-least-once: a link that drops after the brain applied a write but before its answer arrived
   * replays it. Every allowlisted write is a status report or an append, so a duplicate is noise.
   */
  drain(send: (req: ApiRequest) => Promise<ApiResponse>): Promise<DrainResult> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      let sent = 0, dropped = 0;
      while (this.names.length) {
        const name = this.names[0];
        let q: Queued;
        try { q = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")); } catch {
          this.remove(name);
          dropped++;
          continue;
        }
        let r: ApiResponse;
        try { r = await send({ session_id: q.session_id, method: q.method, path: q.path, headers: q.headers, body: q.body }); } catch { break; }
        if (r.status === 503 || r.status === 408 || r.status === 429) break;
        if (r.status >= 500) {
          const n = (this.serverErrors.get(name) ?? 0) + 1;
          this.serverErrors.set(name, n);
          if (n < (this.o.maxServerErrors ?? 5)) break;
        }
        if (r.status >= 400) {
          this.log(`queued ${q.method} ${q.path.split("?")[0]} from ${new Date(q.at).toISOString()} dropped — brain answered ${r.status}`);
          dropped++;
        } else sent++;
        this.remove(name); // no-op when put() already evicted it while we were waiting
      }
      if (sent) this.log(`delivered ${sent} queued mc write${sent === 1 ? "" : "s"}${this.names.length ? ` (${this.names.length} left)` : ""}`);
      return { sent, dropped, left: this.names.length };
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  private remove(name: string): void {
    const i = this.names.indexOf(name);
    if (i < 0) return;
    this.names.splice(i, 1);
    this.total -= this.sizes.get(name) ?? 0;
    this.sizes.delete(name);
    this.serverErrors.delete(name);
    try { fs.unlinkSync(path.join(this.dir, name)); } catch {}
  }
}

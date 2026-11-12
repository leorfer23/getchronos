/**
 * Phone access without a domain — what `GET /api/phone/status` reports and what
 * `POST /api/phone/tailscale/enable` does (phone-routes.ts; the Desk's Phone dialog, static/desk-phone.js).
 *
 * Why Tailscale. The phone surface (/phone) is a PWA: its service worker, Web Push and microphone all
 * need a secure context, i.e. HTTPS. The daemon listens on 127.0.0.1 only and keeps doing so.
 * `tailscale serve --bg <port>` puts a real certificate in front of it at
 * https://<machine>.<tailnet>.ts.net, reachable only from devices on the operator's own tailnet —
 * free, no domain, sign-in with Google/Apple/GitHub. tailscaled terminates TLS and proxies to
 * http://127.0.0.1:<port>, so every such request arrives on loopback like a local agent's: that is
 * what phone-gate.ts is for, and why enabling records the owner it compares against.
 *
 * Never `tailscale funnel`. Funnel publishes the same proxy on the public internet, where the admin
 * token would be the only thing between a stranger and a shell (SECURITY.md). The runner executes an
 * allowlist of exact argv shapes and funnel is not one of them — nor is `serve reset` or `off`: this
 * module never removes anything it did not add.
 *
 * Cloudflare stays the documented advanced path (CONFIGURATION.md §4): when the operator already has
 * one, its URL is reported as method "cloudflare".
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deskBase } from "./artifacts.js";
import { CONFIG } from "./config.js";
import { phoneOwner, setPhoneOwner } from "./phone-gate.js";
import { tailscaleBin } from "./vpn.js";

export type RunResult = { code: number | null; stdout: string; stderr: string; missing?: boolean; timedOut?: boolean };
/** Runs `tailscale <args>`. Injected in tests; the real one only runs allowedTailscaleArgs. */
export type Run = (args: string[], timeoutMs: number) => Promise<RunResult>;

/** Every argv this module may hand the tailscale CLI — read-only status, and serve for one port. */
export function allowedTailscaleArgs(args: string[]): boolean {
  const s = args.join(" ");
  return s === "status --json --peers=false" || s === "serve status --json" || /^serve --bg \d{1,5}$/.test(s);
}

export const realRun: Run = (args, timeoutMs) => {
  if (!allowedTailscaleArgs(args)) return Promise.reject(new Error(`refused to run: tailscale ${args.join(" ")}`));
  return new Promise((resolve) => {
    execFile(tailscaleBin(), args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      if (e && e.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (e && typeof e.code !== "number" ? String(e.message) : ""),
        timedOut: !!e?.killed,
      });
    });
  });
};

export type Fix = { command?: string; link?: string; label?: string };
/** Where the operator is on the way to a paired phone. `on` = serving this daemon AND the owner recorded. */
export type TailscaleStep =
  | "missing" | "stopped" | "starting" | "logged-out" | "needs-approval" | "no-https" | "tagged"
  | "conflict" | "funnel" | "ready" | "on" | "error";
export type TailscaleStatus = {
  installed: boolean;
  running: boolean;
  https_ready: boolean;
  serving: boolean;
  url: string | null;
  step: TailscaleStep;
  /** One plain sentence or two: what is true and what to do next. */
  message: string;
  fix: Fix | null;
  host: string | null;
  owner_set: boolean;
};
export type CloudflareStatus = { configured: boolean; url: string | null };
export type PhoneStatus = {
  url: string | null;
  method: "tailscale" | "cloudflare" | null;
  tailscale: TailscaleStatus;
  cloudflare: CloudflareStatus;
};

export type PhoneDeps = {
  run: Run;
  port: number;
  env: NodeJS.ProcessEnv;
  home: string;
  owner: () => string | null;
  setOwner: (login: string) => void;
};
export const defaultPhoneDeps = (): PhoneDeps => ({
  run: realRun,
  port: CONFIG.port,
  env: process.env,
  home: os.homedir(),
  owner: phoneOwner,
  setOwner: setPhoneOwner,
});

const ADMIN_DNS = "https://console.tailscale.com/admin/dns";
const ADMIN_MACHINES = "https://console.tailscale.com/admin/machines";
export const TAILSCALE_LINKS = {
  mac: "https://tailscale.com/download/mac",
  ios: "https://apps.apple.com/us/app/tailscale/id1470499037",
  android: "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
};
/** Verified against Homebrew: the cask is `tailscale-app` (`tailscale` is its old name). */
export const MAC_INSTALL = "brew install --cask tailscale-app";

const STATUS_MS = 8_000;
// `serve --bg` returns in about a second. It only blocks when the tailnet still has to allow HTTPS
// (the CLI then waits, with no timeout of its own, for someone to click the link it printed) — the
// status check refuses that case first, and this bounds it if the two race.
const SERVE_MS = 30_000;

function parseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

/** The port a serve handler's Proxy points at on this machine, or null (a file, text, a redirect, another host). */
export function proxyPort(proxy: unknown): number | null {
  if (typeof proxy !== "string" || !proxy) return null;
  if (/^\d{1,5}$/.test(proxy)) return Number(proxy);
  try {
    const u = new URL(/^[a-z+]+:\/\//i.test(proxy) ? proxy : "http://" + proxy);
    if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return null;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return null;
  }
}

type ServeRead = { ours: boolean; other: string | null; funnel: boolean };
/**
 * What serve does with https://<host>/ today: ours (proxying to this daemon's port), someone else's
 * (`other` says what), and whether Funnel makes it public. Foreground sessions (a `tailscale serve`
 * left running in a terminal) occupy the address too, so they count.
 */
export function readServe(cfg: any, host: string, port: number): ServeRead {
  const hp = `${host}:443`;
  const out: ServeRead = { ours: false, other: null, funnel: false };
  const look = (c: any, fg: boolean) => {
    if (!c || typeof c !== "object") return;
    if (c.AllowFunnel?.[hp]) out.funnel = true;
    if (c.TCP?.["443"]?.TCPForward) out.other ??= `TCP forwarding to ${c.TCP["443"].TCPForward}`;
    const h = c.Web?.[hp]?.Handlers?.["/"];
    if (!h) return;
    if (proxyPort(h.Proxy) === port) out.ours = true;
    else out.other ??= (fg ? "a `tailscale serve` running in a terminal: " : "") + (h.Proxy ? `proxy to ${h.Proxy}` : h.Path ? `the files at ${h.Path}` : h.Redirect ? `a redirect to ${h.Redirect}` : "something else");
  };
  look(cfg, false);
  for (const fg of Object.values(cfg?.Foreground ?? {})) look(fg, true);
  if (out.other) out.ours = false;
  return out;
}

type Detected = { status: TailscaleStatus; login: string | null; funnelOurs: boolean };

/** Ask the tailscale CLI where things stand. Read-only: two status calls, nothing changes. */
export async function detectTailscale(d: PhoneDeps): Promise<Detected> {
  const owner = d.owner();
  const base: TailscaleStatus = {
    installed: true, running: false, https_ready: false, serving: false, url: null,
    step: "error", message: "", fix: null, host: null, owner_set: !!owner,
  };
  const say = (step: TailscaleStep, message: string, fix: Fix | null = null, extra: Partial<TailscaleStatus> = {}): Detected =>
    ({ status: { ...base, ...extra, step, message, fix }, login: null, funnelOurs: false });

  const st = await d.run(["status", "--json", "--peers=false"], STATUS_MS);
  if (st.missing) {
    return say("missing", "Tailscale isn't installed on this Mac. Install it (free), sign in, then check again.",
      { command: MAC_INSTALL, link: TAILSCALE_LINKS.mac, label: "Download for Mac" }, { installed: false });
  }
  const j = parseJson(st.stdout);
  const backend = typeof j?.BackendState === "string" ? j.BackendState : "";
  if (!j || !backend) {
    // The CLI is there but its daemon isn't answering: on a Mac that is the Tailscale app not running.
    return say("stopped", "Tailscale is installed but not running. Open the Tailscale app, then check again.");
  }
  if (backend === "NeedsLogin") return say("logged-out", "Tailscale is installed but not signed in. Open the Tailscale app and sign in (Google, Apple, GitHub…), then check again.");
  if (backend === "NeedsMachineAuth") return say("needs-approval", "This Mac is waiting for your tailnet's admin to approve it in the Tailscale admin console.", { link: ADMIN_MACHINES, label: "Open Machines" });
  if (backend === "Stopped") return say("stopped", "Tailscale is off. Turn it on from the Tailscale menu, then check again.");
  if (backend !== "Running") return say("starting", "Tailscale is starting. Check again in a moment.");

  const self = j.Self ?? {};
  const running = { running: true };
  if (Array.isArray(self.Tags) && self.Tags.length) {
    return say("tagged", "This Mac is a tagged device in its tailnet, so Tailscale can't say who owns it — and Chronos only answers its owner. Sign this Mac in to your own Tailscale account, or use the Cloudflare setup (CONFIGURATION.md §4).", null, running);
  }
  const certs: string[] = Array.isArray(j.CertDomains) ? j.CertDomains.filter((x: unknown) => typeof x === "string" && x) : [];
  const dns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : "";
  const host = certs.find((c) => c === dns) ?? certs[0] ?? (dns || null);
  if (!certs.length || j.CurrentTailnet?.MagicDNSEnabled === false) {
    return say("no-https", "Your tailnet hasn't turned on HTTPS certificates, and the phone app needs HTTPS. On the DNS page of the Tailscale admin console, turn on MagicDNS if it's off, then select Enable HTTPS. Machine names go into a public certificate log, so rename this Mac first if its name is private. Then check again.",
      { link: ADMIN_DNS, label: "Open DNS settings" }, { ...running, host });
  }
  const login = typeof j.User?.[String(self.UserID)]?.LoginName === "string" ? j.User[String(self.UserID)].LoginName : null;
  const url = `https://${host}`;
  const ready = { ...running, https_ready: true, host };

  const sv = await d.run(["serve", "status", "--json"], STATUS_MS);
  const cfg = parseJson(sv.stdout || "{}");
  if (sv.code !== 0 || cfg === null) return say("error", `Couldn't read Tailscale's serve settings: ${(sv.stderr || sv.stdout).trim().slice(0, 200) || `exit ${sv.code}`}`, null, ready);
  const r = readServe(cfg, host!, d.port);
  if (r.other) {
    return say("conflict", `Tailscale on this Mac already shares something else at ${url} (${r.other}). Chronos won't replace it. To give that address to Chronos, turn the other one off, then check again.`,
      { command: "tailscale serve --https=443 off" }, ready);
  }
  const detected = (step: TailscaleStep, message: string, extra: Partial<TailscaleStatus> = {}): Detected =>
    ({ status: { ...base, ...ready, url, step, message, fix: null, ...extra }, login, funnelOurs: r.funnel && r.ours });
  if (r.funnel) {
    // Funnel on our own address: public. The gate refuses every Funnel request, and `serve --bg` turns
    // Funnel off for the port it sets (tailscale serve_v2.go applyFunnel) — so enabling is the fix.
    return detected("funnel", `Tailscale Funnel is putting Chronos on the public internet at ${url}. Chronos refuses everything that comes in that way, but turn it off: Turn on phone access makes the address private to your tailnet again.`, { serving: r.ours });
  }
  if (r.ours && owner && login && owner === login) return detected("on", `Phone access is on at ${url} — private to your own Tailscale devices.`, { serving: true });
  if (r.ours && owner) return detected("ready", "Tailscale on this Mac is signed in to a different account than the one phone access was turned on for. Turn it on again to make this account the owner.", { serving: true });
  if (r.ours) return detected("ready", `Tailscale already shares Chronos at ${url}. Turn on phone access to finish: Chronos records your Tailscale account as the only one it answers.`, { serving: true });
  return detected("ready", "Ready. Your phone will reach this Mac over Tailscale — private to your own devices, no domain needed.");
}

/** The Cloudflare tunnel of CONFIGURATION.md §4, if this Mac has one: its token file, and the public URL when one is configured. */
export function cloudflareSetup(env: NodeJS.ProcessEnv, home: string): CloudflareStatus {
  const token = fs.existsSync(path.join(home, ".cloudflared", "chronos-desk.token"));
  const base = deskBase(env);
  let url: string | null = null;
  try {
    const u = new URL(base);
    if (u.protocol === "https:" && !/(^|\.)ts\.net$/i.test(u.hostname)) url = u.origin;
  } catch {}
  return { configured: token || url !== null, url };
}

export async function phoneStatus(d: PhoneDeps): Promise<PhoneStatus> {
  const ts = (await detectTailscale(d)).status;
  const cloudflare = cloudflareSetup(d.env, d.home);
  const method = ts.step === "on" ? "tailscale" : cloudflare.url ? "cloudflare" : null;
  return { url: method === "tailscale" ? ts.url : method === "cloudflare" ? cloudflare.url : null, method, tailscale: ts, cloudflare };
}

export type EnableResult =
  | { ok: true; url: string }
  | { ok: false; status: number; error: string; step?: TailscaleStep; fix?: Fix | null };

let inflight: Promise<EnableResult> | null = null;
/**
 * Turn phone access on: `tailscale serve --bg <port>` unless serve already proxies this daemon, then
 * record the Mac's Tailscale login as the one account the gate lets through. Refuses — without
 * touching serve — whenever the status says a step comes first, or the address belongs to something
 * else (serve would silently replace it: SetWebHandler has no "already exists" check).
 */
export function enableTailscale(d: PhoneDeps): Promise<EnableResult> {
  inflight ??= doEnable(d).finally(() => { inflight = null; });
  return inflight;
}

async function doEnable(d: PhoneDeps): Promise<EnableResult> {
  const first = await detectTailscale(d);
  const s = first.status;
  const refuse = (x: TailscaleStatus, status = 409): EnableResult => ({ ok: false, status, error: x.message, step: x.step, fix: x.fix });
  if (s.step !== "ready" && s.step !== "on" && s.step !== "funnel") return refuse(s);
  if (!first.login) return { ok: false, status: 502, error: "Tailscale is running but didn't say which account this Mac is signed in to — check `tailscale status`." };

  if (!s.serving || first.funnelOurs) {
    const r = await d.run(["serve", "--bg", String(d.port)], SERVE_MS);
    if (r.code !== 0 || r.timedOut) {
      const out = `${r.stdout}\n${r.stderr}`;
      const link = /https:\/\/[a-z0-9.-]*tailscale\.com\/\S*/i.exec(out)?.[0];
      if (link) return { ok: false, status: 409, error: "Tailscale needs one more click from you before it can share Chronos over HTTPS.", step: "no-https", fix: { link, label: "Open Tailscale" } };
      return { ok: false, status: 502, error: r.timedOut ? "Tailscale didn't finish within 30 seconds — check the Tailscale app, then try again." : `tailscale serve failed: ${out.trim().slice(0, 300) || `exit ${r.code}`}` };
    }
  }
  // Trust what serve now says, not what the command printed.
  const after = await detectTailscale(d);
  const a = after.status;
  if (!a.serving || after.funnelOurs || !a.url) {
    return { ok: false, status: 502, error: a.step === "conflict" || a.step === "funnel" ? a.message : "Tailscale accepted the command, but `tailscale serve status` doesn't show Chronos yet — try again.", step: a.step, fix: a.fix };
  }
  if (after.login !== first.login) return { ok: false, status: 409, error: "The Tailscale account on this Mac changed while turning phone access on — try again." };
  d.setOwner(first.login);
  return { ok: true, url: a.url };
}

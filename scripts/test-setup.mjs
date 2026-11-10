// Preloaded into every test process (`node --import tsx --import ./scripts/test-setup.mjs --test …`;
// node hands --import on to each per-file child). One place for what a test run must never do:
//
// - talk to a real model: the agent CLIs resolve to scripts/test-bin/no-cli, which exits 1. Tests that
//   need a CLI write their own fake and set CHRONOS_<NAME>_BIN before importing config — that still wins.
// - reach the network: a socket to anything but loopback (or a unix socket) is refused and named on
//   stderr. Fetch, http(s), ws and undici all connect through net.Socket.
// - touch the live daemon's DB, or spawn under sandbox-exec by default.
//
// The env defaults below are the ones `npm test` used to spell out inline; `??=` lets a caller override.
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-bin");
const env = process.env;
env.CHRONOS_TEST = "1";
env.CHRONOS_DB ??= ":memory:";
env.CHRONOS_MAX_CONCURRENT ??= "3";
env.CHRONOS_DAILY_BUDGET ??= "5";
env.CHRONOS_RESUME_RL_MAX_HOURS ??= "6";
env.CHRONOS_DESKTOP_NOTIFY ??= "0";
env.CHRONOS_SANDBOX_DEFAULT ??= "off";
env.CHRONOS_QUOTA_GATE ??= "off";

if (!(env.PATH ?? "").startsWith(bin + path.delimiter)) env.PATH = bin + path.delimiter + (env.PATH ?? "");
// These two default to absolute paths in config.ts, so PATH alone does not reach them.
env.CHRONOS_GROK_BIN ??= path.join(bin, "grok");
env.CHRONOS_ICAL_BIN ??= path.join(bin, "ical");

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+|0\.0\.0\.0|::)$/i;
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  const opts = Array.isArray(o) ? o[0] : o;
  const host = typeof opts === "object" && opts !== null ? opts.host ?? (opts.path ? null : "localhost") : typeof args[1] === "string" ? args[1] : typeof o === "string" ? null : "localhost";
  if (host != null && !LOOPBACK.test(String(host).replace(/^\[|\]$/g, ""))) {
    const port = typeof opts === "object" && opts !== null ? opts.port : o;
    const err = Object.assign(new Error(`chronos tests: network is off — refused ${host}:${port} (scripts/test-setup.mjs)`), { code: "ECONNREFUSED" });
    process.stderr.write(`[test-net] refused ${host}:${port}\n`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};

#!/usr/bin/env node
// The one way to run the tests, so every run gets the same preload (scripts/test-setup.mjs: env,
// no real CLIs, no network).
//
//   npm test                       fast suite: src unit tests + scripts/mc tests + evals
//   npm run test:all               + the slow suite (real ptys, multi-host links, swiftc, a real
//                                  browser, audio) — what CI runs
//   npm test -- src/foo.test.ts    just those files (fast and slow alike)
//
// A slow test is either a whole file (SLOW_FILES) or a single test that opts out with
// `{ skip: !process.env.CHRONOS_TEST_SLOW && "slow suite: npm run test:all" }`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLOW_FILES = /\.(pty|integration)\.test\.ts$/;

const args = process.argv.slice(2);
const all = args.includes("--all");
const flags = args.filter((a) => a.startsWith("--") && a !== "--all");
let files = args.filter((a) => !a.startsWith("--"));

if (!files.length) {
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true }).map((f) => path.join(dir, String(f)));
  files = [
    ...walk("src").filter((f) => f.endsWith(".test.ts") && (all || !SLOW_FILES.test(f))),
    ...walk("scripts").filter((f) => /^scripts\/mc-[^/]+\.test\.mjs$/.test(f)),
    ...walk("evals").filter((f) => f.endsWith(".eval.ts")),
  ];
  // Longest first, so a long file is not the last one to start: the slow files, then by size (a
  // rough stand-in for how long a file runs).
  const size = (f) => fs.statSync(path.join(root, f)).size;
  files.sort((a, b) => Number(SLOW_FILES.test(b)) - Number(SLOW_FILES.test(a)) || size(b) - size(a));
}

const env = { ...process.env, ...(all || args.some((a) => !a.startsWith("--")) ? { CHRONOS_TEST_SLOW: "1" } : {}) };
const r = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/test-setup.mjs", "--test", ...flags, ...files], { cwd: root, env, stdio: "inherit" });
process.exit(r.status ?? 1);

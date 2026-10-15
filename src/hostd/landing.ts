/**
 * Where a repo-less terminal lands on a host (SpawnSpec `cwd_hint: "landing"`).
 *
 * On the brain a workspace's landing dir is its `default_dir`: a folder holding that client's
 * checkouts, often a symlink farm, so a terminal opened without a repo can reach all of them instead
 * of starting in whichever repo sorts first (terminal.ts resolveCwd). A host has no `default_dir` — it
 * is a brain path — so it builds the same thing from its OWN checkouts of the workspace's repos: a
 * folder of symlinks, one per repo, under a directory Chronos owns (`~/.chronos-landing/<slug>`).
 * Never inside the operator's own folders, where a client slug could name a real checkout.
 *
 * Only symlinks are ever created or removed in it; anything else found there is left alone. A
 * workspace with one repo here lands in that repo, exactly as the brain does without a `default_dir`.
 */
import fs from "node:fs";
import path from "node:path";

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** The farm's entry names: each repo's folder name, suffixed on a clash. */
function namesFor(repoPaths: string[]): Map<string, string> {
  const want = new Map<string, string>();
  for (const p of [...new Set(repoPaths)]) {
    const base = path.basename(p) || "repo";
    let name = base;
    for (let n = 2; want.has(name); n++) name = `${base}-${n}`;
    want.set(name, p);
  }
  return want;
}

/**
 * Create (or bring up to date) `<root>/<slug>` with one symlink per repo path and return its real
 * path, or null when there is nothing to build or it cannot be built (the caller falls back).
 */
export function ensureLandingDir(root: string, slug: string, repoPaths: string[]): string | null {
  if (!SAFE_SLUG.test(slug) || slug.includes("..") || repoPaths.length < 2) return null;
  const dir = path.join(root, slug);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const want = namesFor(repoPaths);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      let target: string | null = null;
      try { target = fs.readlinkSync(full); } catch {}
      if (want.get(e.name) !== target) fs.unlinkSync(full);
    }
    for (const [name, target] of want) {
      const full = path.join(dir, name);
      let exists = false;
      try { fs.lstatSync(full); exists = true; } catch {}
      if (!exists) fs.symlinkSync(target, full);
    }
    return fs.realpathSync.native(dir);
  } catch (e: any) {
    console.warn(`[host] landing dir for ${slug} not built (${e?.message ?? e}) — landing in its first repo`);
    return null;
  }
}

import fs from "node:fs";
import path from "node:path";
import { CONFIG } from "./config.js";
import { workspaces, repos } from "./store.js";
import { detectOriginUrl, detectDefaultBranch } from "./repo-git.js";
import { bus } from "./bus.js";

// A workspace's default_dir is the folder holding ALL its checkouts (migration 105) — but a repo
// cloned into it was invisible to Chronos until someone registered it by hand in the dashboard,
// so tickets couldn't target it and the sandbox denied it to every other workspace late. This
// sweep closes that gap: any direct child of a default_dir that is a git checkout becomes a repo
// row automatically.
//
// Dedup is by REALPATH, not by row path: a default_dir may hold a symlink to a checkout that is
// already registered under its real location (GFM's deci_ai), and registering it twice would make
// the same working tree two "repos" — two ticket worktree roots over one .git. New symlinked
// checkouts are stored under their real path for the same reason (sandbox rules and worktrees
// operate on real paths).
//
// Registration only — a vanished folder never deletes its row here. A repo row carries operator
// decisions (delivery, gates, done criteria) and losing those because a disk was unmounted for a
// sweep tick is not recoverable; unregistering stays a dashboard action.
export async function scanDefaultDirs(): Promise<number> {
  let added = 0;
  for (const ws of workspaces.list()) {
    if (!ws.default_dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(ws.default_dir, { withFileTypes: true });
    } catch {
      continue; // unset-in-practice: dir missing/unreadable this tick
    }
    const known = new Set(
      repos.list(ws.id).map((r) => {
        try {
          return fs.realpathSync(r.path);
        } catch {
          return r.path; // row's checkout missing right now — keep its literal path as the claim
        }
      }),
    );
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      let real: string;
      try {
        real = fs.realpathSync(path.join(ws.default_dir, e.name));
        if (!fs.statSync(real).isDirectory()) continue;
      } catch {
        continue; // dangling symlink
      }
      if (!fs.existsSync(path.join(real, ".git"))) continue;
      if (known.has(real)) continue;
      const git_remote = await detectOriginUrl(real);
      const default_branch = (await detectDefaultBranch(real)) ?? "main";
      // No origin = nowhere to open a PR; such a checkout ships by local commit until the
      // operator says otherwise (both fields stay editable in the dashboard).
      repos.create({
        workspace_id: ws.id,
        name: e.name,
        path: real,
        git_remote,
        default_branch,
        delivery: git_remote ? "pr" : "commit",
      });
      known.add(real);
      added++;
      console.log(`[repo-scan] ${ws.slug}: registered ${e.name} → ${real}`);
    }
  }
  if (added) bus.publish({ topic: "workspace.changed" });
  return added;
}

export function startRepoScan(): void {
  if (!CONFIG.repoScanMin) return;
  const tick = () =>
    void scanDefaultDirs().catch((e) => console.error("[repo-scan] sweep failed:", e));
  tick();
  setInterval(tick, CONFIG.repoScanMin * 60_000).unref();
}

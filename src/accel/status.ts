import { ACCELERATOR_TOOLS, repoAccelerators } from "../store/accelerators.js";
import { detectTool } from "./detect.js";
import { freshness, configHashOf } from "./manifest.js";
import type { AcceleratorTool, Repo, Workspace } from "../types.js";

export interface AccelToolStatus {
  tool: AcceleratorTool;
  enabled: boolean;
  mode: string | null;
  installed: boolean;
  version: string | null;
  detail?: string;
  freshness: "fresh" | "stale" | "missing" | "n/a";
}

/**
 * The full per-repo picture `GET /repos/:id/accel` and `mc accel status` report: stored on/off state
 * next to live detection, for all three tools, in one pass. Freshness only means something for a
 * tool that builds a persisted artifact — ast-grep/repomix are on-demand CLI invocations with
 * nothing of ours to go stale, so they report "n/a" rather than a fabricated "missing". Freshness is
 * checked against the tool's CURRENT detected version and the row's current mode, so an upgrade or a
 * mode flip shows as stale even when HEAD hasn't moved.
 */
export function accelStatus(repo: Repo, workspace: Workspace): AccelToolStatus[] {
  return ACCELERATOR_TOOLS.map((tool) => {
    const persisted = repoAccelerators.get(repo.id, tool);
    const det = detectTool(tool, workspace.config_dir);
    // detectGraphify already returns the canonical semver so freshness matches manifests.
    const fresh = tool === "graphify"
      ? freshness({
          workspaceId: workspace.id, repoId: repo.id, tool, repoPath: repo.path,
          toolVersion: det.version, configHash: configHashOf(persisted?.mode ?? null),
        }).state
      : "n/a";
    return {
      tool,
      enabled: !!persisted?.enabled,
      mode: persisted?.mode ?? null,
      installed: det.installed,
      version: det.version,
      detail: det.detail,
      freshness: fresh,
    };
  });
}

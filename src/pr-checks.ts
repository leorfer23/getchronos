/**
 * `mc pr checks <url>`: a PR's state and CI, for an agent whose workspace runs on a fine-grained
 * GitHub token. GitHub offers those tokens no Checks permission, so `gh pr checks` (and any
 * `statusCheckRollup`) fails from the agent's own shell. The daemon reads it with the operator's login
 * (child-env.ts ghReadEnv), and only for a PR of the caller's own workspace (pr-ownership.ts): the
 * daemon's wider reach never carries one workspace's PRs to another.
 */
import os from "node:os";
import { ghReadEnv } from "./child-env.js";
import { ciChecks, ciRollup } from "./delivery.js";
import { execFileTimed } from "./exec.js";
import { prBelongsTo, slugOfPr } from "./pr-ownership.js";
import type { Workspace } from "./types.js";

const FIELDS = "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";

export type ViewFn = (url: string, env: NodeJS.ProcessEnv) => Promise<any>;
const realView: ViewFn = async (url, env) =>
  JSON.parse((await execFileTimed("gh", ["pr", "view", url, "--json", FIELDS], { cwd: os.homedir(), env, encoding: "utf8", timeout: 20_000 })).stdout);
let view: ViewFn = realView;
/** Tests only. null restores gh. */
export function setPrChecksView(fn: ViewFn | null): void {
  view = fn ?? realView;
}

export type PrChecks =
  | { ok: true; url: string; state: string | null; isDraft: boolean; mergeable: string | null; mergeStateStatus: string | null; reviewDecision: string | null; ci: ReturnType<typeof ciRollup>; checks: NonNullable<ReturnType<typeof ciChecks>> }
  | { ok: false; status: 400 | 403 | 502; error: string };

export async function prChecks(ws: Workspace, url: string): Promise<PrChecks> {
  if (!slugOfPr(url)) return { ok: false, status: 400, error: "url must be a GitHub pull request URL (https://github.com/<owner>/<repo>/pull/<n>)" };
  const own = prBelongsTo(ws.id, url);
  if (!own.ok) return { ok: false, status: 403, error: `not a PR of this workspace: ${own.why}` };
  let v: any;
  try {
    v = await view(url, ghReadEnv(ws));
  } catch (e: any) {
    return { ok: false, status: 502, error: `gh pr view failed: ${String(e?.stderr ?? e?.message ?? e).trim().slice(0, 300)}` };
  }
  return {
    ok: true,
    url,
    state: v?.state ?? null,
    isDraft: !!v?.isDraft,
    mergeable: v?.mergeable ?? null,
    mergeStateStatus: v?.mergeStateStatus ?? null,
    reviewDecision: v?.reviewDecision || null,
    ci: ciRollup(v?.statusCheckRollup),
    checks: ciChecks(v?.statusCheckRollup) ?? [],
  };
}

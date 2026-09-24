/**
 * Placement (HOSTS.md → Placement): which computer a terminal runs on. One PURE function, `place()`,
 * so every rule is unit-tested the way `admission()` is — no store, no registry, no clock. Its caller
 * (`hosts/candidates.ts`) gathers the facts; openSession acts on the answer.
 *
 * The order is the design's, and each step exists for a reason:
 *
 *  1. **Eligible**: online, not draining/disabled, the workspace allowed by brain policy AND by the
 *     host's own veto, the backend's CLI installed, the workspace's profile present, the repo checked
 *     out (or `auto_clone`), no egress lock (hosts run no egress proxy until phase 5), and a platform
 *     that can honour the sandbox. The brain is always eligible: it is where every guard in
 *     openSession already runs, and a single-machine install must place exactly as it did.
 *  2. **Sticky**: a resume, a revive, a failover stand-in, a ticket whose worktree is on one machine,
 *     a directory the brain named — that host, or a refusal that says why. Never a silent move: the
 *     CLI transcript and the uncommitted work live on that disk.
 *  3. **Pinned**: the operator (or `mc session new --host`) chose a computer.
 *  4. **Most headroom**: `admission()` per host on its own vitals, then the free-capacity score, with
 *     the brain's reserve subtracted from its own so hosts take work first and the brain the overflow.
 *  5. **Nobody has room**: an operator open goes to the best eligible computer anyway (the operator
 *     is never refused, as before hosts); an agent open is refused with every computer's reason.
 */
import { admission, swapPctOf, type Admission, type MachineLoad } from "../machine.js";

export type PlacementMode = "auto" | "pinned" | "local";

/** What a host must have installed to run a backend (hostd/inventory.ts CLI_NAMES). null = nothing. */
const CLI_FOR: Record<string, string | null> = {
  "claude-code": "claude",
  cursor: "cursor-agent",
  grok: "grok",
  opencode: "opencode",
  codex: "codex",
  // The test stand-in is a `node -e` script; every host that runs chronos has node.
  mock: null,
};
export const cliFor = (backend: string): string | null => (backend in CLI_FOR ? CLI_FOR[backend] : backend);

export type PlaceRequest = {
  workspace: { id: string; slug: string } | null;
  backend: string;
  /** A cloud backend runs on its provider's VM — never on one of our hosts. */
  backend_kind?: "local" | "cloud";
  /** The workspace's profile NAME (spawn-spec.ts profileNameFor). */
  profile: string | null;
  repo: { id: string; name: string; git_remote: string | null } | null;
  needs: { sandbox: string; egress_locked: boolean };
  /** A computer chosen by hand (Desk picker, `--host`). */
  pinned: string | null;
  /** Where this work already lives, and why it cannot move. */
  sticky: { host_id: string; why: string } | null;
  opened_by: "operator" | "agent";
  /**
   * NEW work (a fresh terminal) versus reopening work that already lives somewhere (resume, revive,
   * a stand-in). A draining computer takes no new work but still finishes what it has.
   */
  fresh: boolean;
  /**
   * A failover stand-in takes a walled terminal's place instead of adding a process; refusing it on
   * load would strand the work on a dead CLI exactly when the machine is too busy to notice.
   */
  exempt_admission?: boolean;
};

export type HostCandidate = {
  id: string;
  name: string;
  is_brain: boolean;
  online: boolean;
  status: "online" | "offline" | "draining" | "disabled";
  /** Brain policy for this host (hosts.policy_json deny list: ids or slugs). */
  deny: string[];
  /** The host's own veto (CHRONOS_HOST_DENY), as it reported it. */
  veto: string[];
  platform: string;
  sandbox: boolean;
  /** CLI names the host found on its PATH. */
  clis: string[];
  profiles: Array<{ name: string; exists: boolean }>;
  /** Repo ids checked out on this host (repo_checkouts). */
  checkouts: string[];
  auto_clone: boolean;
  /** Its latest governor reading, or null when there is none recent enough to trust. */
  load: MachineLoad | null;
  /** RAM in use, % (Activity Monitor's "Memory Used"), or null when unknown. */
  ram_pct: number | null;
};

export type GovernorCfg = { enabled: boolean; maxLoadPerCore: number; maxSwapUsedPct: number };

export type PlaceInput = {
  req: PlaceRequest;
  hosts: HostCandidate[];
  cfg: GovernorCfg;
  /** CHRONOS_BRAIN_RESERVE: headroom points taken off the brain's score. */
  reserve: number;
  mode: PlacementMode;
};

export type Placed = {
  ok: true;
  host_id: string;
  /** One line for the log, the session row and the Desk card: "most headroom (m2 62 · local 18)". */
  reason: string;
  /** Was there anything to decide? False when the brain was the only computer in play. */
  chose: boolean;
};

export type Refused = {
  ok: false;
  /** policy → 403 (someone asked for a computer the workspace may not use); the rest → 409 / 400. */
  kind: "policy" | "unavailable" | "full";
  message: string;
  /** Every computer's reason, by id — what the refusal line is built from. */
  reasons: Record<string, string>;
};

export type Placement = Placed | Refused;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Free capacity on a 0-100 scale. Half CPU (1-minute load per core against the governor's own
 * ceiling, so "full" means what admission means by full), half memory (RAM not in use), then memory
 * PRESSURE — the signal macOS itself trusts — takes points off: warning 25, critical 50, plus 10 when
 * swap is also past the governor's line under pressure (swap alone is a calm Mac's resting state, see
 * machine.ts). No reading scores 0: an unknown machine is never the most attractive one.
 */
export function headroom(h: Pick<HostCandidate, "load" | "ram_pct">, cfg: GovernorCfg): number {
  const l = h.load;
  if (!l) return 0;
  const cpu = clamp01(1 - l.loadPerCore / (cfg.maxLoadPerCore > 0 ? cfg.maxLoadPerCore : 2.5));
  // No RAM figure (a brain that has not sampled yet, a platform without one): neither empty nor full.
  const ram = h.ram_pct == null ? 0.5 : clamp01(1 - h.ram_pct / 100);
  let s = 100 * (0.5 * cpu + 0.5 * ram);
  if (l.pressureLevel === 2) s -= 25;
  else if (l.pressureLevel === 4) s -= 50;
  const swap = swapPctOf(l);
  if ((l.pressureLevel ?? 1) >= 2 && swap != null && swap > cfg.maxSwapUsedPct) s -= 10;
  return Math.round(s * 10) / 10;
}

/** The governor's verdict for one computer, on its own numbers. */
export function admits(h: Pick<HostCandidate, "load" | "name">, cfg: GovernorCfg): Admission {
  if (!cfg.enabled) return { ok: true };
  if (!h.load) return { ok: false, reason: `no recent vitals from ${h.name}` };
  return admission(h.load, cfg);
}

const denied = (list: string[], ws: PlaceRequest["workspace"]) => !!ws && list.some((d) => d === ws.id || d === ws.slug);

/**
 * Why this computer cannot take this work, or null when it can. `kind` separates a boundary (policy:
 * the workspace may not run there) from a gap (it just cannot right now), which the API reports as
 * 403 versus 409 when someone asked for that computer by name.
 */
export function ineligible(h: HostCandidate, req: PlaceRequest): { kind: "policy" | "unavailable"; reason: string } | null {
  if (h.is_brain) return null;
  const gap = (reason: string) => ({ kind: "unavailable" as const, reason });
  if (!h.online) return gap("offline");
  if (h.status === "disabled") return gap("disabled");
  if (h.status === "draining" && req.fresh) return gap("draining — takes no new work");
  const ws = req.workspace;
  // Worded like the phase-3 lock (terminal.ts assertRemotePlacement), which callers already match on.
  if (denied(h.deny, ws)) return { kind: "policy", reason: `workspace ${ws!.slug} is not allowed on host ${h.name} (brain policy)` };
  if (denied(h.veto, ws)) return { kind: "policy", reason: `workspace ${ws!.slug} is not allowed on host ${h.name} (its own veto)` };
  if (req.backend_kind === "cloud") return gap(`${req.backend} runs on its provider's VM, not on a host`);
  if (req.needs.egress_locked) return gap("egress-locked workspaces run on the brain until hosts run the egress proxy (phase 5)");
  if (h.platform !== "darwin") return gap(`${h.platform || "unknown platform"} — terminals need macOS (Seatbelt)`);
  if (req.needs.sandbox !== "off" && !h.sandbox) return gap(`cannot sandbox (${req.needs.sandbox}) — no sandbox-exec`);
  const cli = cliFor(req.backend);
  if (cli && !h.clis.includes(cli)) return gap(`${cli} not installed`);
  if (req.profile) {
    const p = h.profiles.find((x) => x.name === req.profile);
    // claude-code keeps its login IN the profile dir; the other CLIs only need the name to resolve.
    if (!p || (req.backend === "claude-code" && !p.exists)) return gap(`profile ${req.profile} not set up there`);
  }
  if (req.repo) {
    if (!req.repo.git_remote) return gap(`repo ${req.repo.name} has no git remote to find it by`);
    if (!h.checkouts.includes(req.repo.id) && !h.auto_clone) return gap(`${req.repo.name} not checked out`);
  }
  return null;
}

/**
 * Best first: a computer we have a reading for, then score, then a host before the brain, then name,
 * then id — the same inputs, the same pick. A host with no recent vitals ranks last whatever the
 * others score: when the operator is placed on "the least-bad", it must be a machine we can see.
 */
function rank(a: { h: HostCandidate; score: number }, b: { h: HostCandidate; score: number }): number {
  if (!a.h.load !== !b.h.load) return a.h.load ? -1 : 1;
  if (b.score !== a.score) return b.score - a.score;
  if (a.h.is_brain !== b.h.is_brain) return a.h.is_brain ? 1 : -1;
  return a.h.name.localeCompare(b.h.name) || a.h.id.localeCompare(b.h.id);
}

/** A reason for a refused open onto ONE computer — today's wording when it is the brain. */
function saturated(h: HostCandidate, reason: string): string {
  return h.is_brain ? `machine saturated — ${reason}` : `${h.name} is saturated — ${reason}`;
}

/** Place work on a specific computer (sticky or pinned): eligible, then admitted, or refused. */
function onto(h: HostCandidate | undefined, id: string, req: PlaceRequest, cfg: GovernorCfg, label: string, prefix: string): Placement {
  if (!h) return { ok: false, kind: "unavailable", message: `${prefix}unknown computer \`${id}\` — not connected to this brain`, reasons: { [id]: "unknown" } };
  const no = ineligible(h, req);
  if (no) return { ok: false, kind: no.kind, message: no.kind === "policy" ? `${prefix}${no.reason}` : `${prefix}${h.name}: ${no.reason}`, reasons: { [h.id]: no.reason } };
  if (req.opened_by === "agent" && !req.exempt_admission) {
    const a = admits(h, cfg);
    if (!a.ok) return { ok: false, kind: "full", message: saturated(h, a.reason), reasons: { [h.id]: a.reason } };
  }
  return { ok: true, host_id: h.id, reason: label, chose: false };
}

export function place(input: PlaceInput): Placement {
  const { req, hosts, cfg, reserve, mode } = input;
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const brain = hosts.find((h) => h.is_brain);

  // 2. Sticky: where the work already is. Honoured in every mode — the kill switch stops NEW work
  // flowing out; it does not strand a terminal whose transcript lives on another disk.
  if (req.sticky) {
    const s = req.sticky;
    if (req.pinned && req.pinned !== s.host_id) {
      const there = byId.get(s.host_id)?.name ?? s.host_id;
      return {
        ok: false, kind: "unavailable",
        message: `${s.why} on ${there}, but this terminal was pinned to ${byId.get(req.pinned)?.name ?? req.pinned} — pin it to ${there}, or leave the computer on Auto`,
        reasons: { [req.pinned]: `sticky to ${there}` },
      };
    }
    const h = byId.get(s.host_id);
    return onto(h, s.host_id, req, cfg, `sticky — ${s.why}`, `cannot move (${s.why}) — `);
  }

  // 3. Pinned.
  if (req.pinned) {
    const h = byId.get(req.pinned);
    if (mode === "local" && !h?.is_brain) {
      return { ok: false, kind: "unavailable", message: "placement is brain-only right now (CHRONOS_PLACEMENT=local) — leave the computer on Auto", reasons: { [req.pinned]: "placement is local-only" } };
    }
    return onto(h, req.pinned, req, cfg, "pinned", "");
  }

  // 4. Most headroom — among every computer in auto mode, only the brain otherwise.
  const pool = mode === "auto" ? hosts : hosts.filter((h) => h.is_brain);
  const reasons: Record<string, string> = {};
  const eligible: Array<{ h: HostCandidate; score: number; raw: number; adm: Admission }> = [];
  for (const h of pool) {
    const no = ineligible(h, req);
    if (no) { reasons[h.id] = no.reason; continue; }
    const raw = headroom(h, cfg);
    const adm = admits(h, cfg);
    eligible.push({ h, raw, score: h.is_brain ? raw - reserve : raw, adm });
    if (!adm.ok) reasons[h.id] = adm.reason;
  }
  if (!eligible.length) {
    // Only reachable without a brain candidate (a caller bug): refuse rather than guess.
    return { ok: false, kind: "unavailable", message: `no computer can run this — ${line(reasons, byId)}`, reasons };
  }
  eligible.sort(rank);
  const roomy = eligible.filter((e) => e.adm.ok);
  const scores = eligible.map((e) => (e.h.is_brain && reserve ? `${e.h.name} ${fmt(e.raw)}−${fmt(reserve)}` : `${e.h.name} ${fmt(e.raw)}`)).join(" · ");
  const chose = pool.length > 1;
  if (roomy.length) {
    const best = roomy[0];
    const reason = !chose
      ? "the only computer"
      : eligible.length === 1
        ? `the only computer that can run it (${line(reasons, byId)})`
        : `most headroom (${scores})`;
    return { ok: true, host_id: best.h.id, reason, chose };
  }
  // 5. Nobody has room. The operator is never refused — he gets the least-bad computer. Nor is a
  // failover stand-in: it takes a walled terminal's place rather than adding a process.
  if (req.opened_by === "operator" || req.exempt_admission) {
    const best = eligible[0];
    return { ok: true, host_id: best.h.id, reason: !chose ? "the only computer" : `every computer is busy — least loaded (${scores})`, chose };
  }
  // An agent is refused, with every computer's reason in one line. One computer in play → today's
  // wording, word for word, so a single-machine install reads exactly as it did.
  if (!chose && brain && eligible.length === 1 && eligible[0].h.is_brain) {
    return { ok: false, kind: "full", message: `machine saturated — ${reasons[brain.id]}`, reasons };
  }
  return { ok: false, kind: "full", message: `no computer has room — ${line(reasons, byId)}`, reasons };
}

const fmt = (n: number) => String(Math.round(n));

/** "m2: load 3.1/core; m5: offline; local: …" — hosts first, the brain last, as the design reads. */
function line(reasons: Record<string, string>, byId: Map<string, HostCandidate>): string {
  return Object.entries(reasons)
    .sort(([a], [b]) => Number(!!byId.get(a)?.is_brain) - Number(!!byId.get(b)?.is_brain) || (byId.get(a)?.name ?? a).localeCompare(byId.get(b)?.name ?? b))
    .map(([id, r]) => `${byId.get(id)?.name ?? id}: ${r}`)
    .join("; ");
}

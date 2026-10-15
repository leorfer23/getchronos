/**
 * Git introspection for repo registration (POST/PATCH).
 *
 * The DB's default_branch / git_remote used to be free-form client strings. A typo or omitted
 * default silently became "main", and delivery:'pr' would later fail when shipping against a
 * nonexistent base or with no origin — see PER-19. When `path` exists we read the checkout and
 * either fill omitted fields or reject mismatches; store fixtures that use fake paths are untouched.
 */
import fs from "node:fs";
import { execFileTimed } from "./exec.js";

export class RepoGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoGitError";
  }
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileTimed("git", ["-C", repoPath, ...args], { timeout: 5_000 });
  return stdout.trim();
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** `git remote get-url origin`, or null if origin is missing. */
export async function detectOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const url = await git(repoPath, ["remote", "get-url", "origin"]);
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Best-effort default branch without network.
 * Prefer origin/HEAD (set by clone / `remote set-head`); fall back to origin/main|master, then
 * the current local branch. `git init` + `remote add` alone often has no origin/HEAD.
 */
export async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  try {
    const ref = await git(repoPath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  } catch {
    /* no origin/HEAD */
  }
  for (const b of ["main", "master"]) {
    try {
      await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]);
      return b;
    } catch {
      /* try next */
    }
  }
  try {
    const head = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head && head !== "HEAD") return head;
  } catch {
    /* detached / empty */
  }
  return null;
}

export type RepoGitResolveInput = {
  path: string;
  /** undefined = not supplied in this request (autodetect / keep). */
  default_branch?: string;
  /** undefined = not supplied; null = explicit clear. */
  git_remote?: string | null;
  delivery?: "commit" | "pr";
  /** Which fields were present on the request body (vs inherited from an existing row). */
  explicit: { default_branch: boolean; git_remote: boolean };
};

export type RepoGitResolved = {
  default_branch: string;
  git_remote: string | null;
  delivery: "commit" | "pr";
};

/**
 * Resolve + verify default_branch / git_remote against the checkout at `path`.
 * When `path` does not exist, returns defaults with no filesystem check (ticket scope).
 */
export async function resolveRepoGitFields(input: RepoGitResolveInput): Promise<RepoGitResolved> {
  const delivery: "commit" | "pr" = input.delivery ?? "pr";
  const pathExists = fs.existsSync(input.path);

  if (!pathExists) {
    return {
      default_branch: input.default_branch ?? "main",
      git_remote: input.git_remote !== undefined ? input.git_remote : null,
      delivery,
    };
  }

  if (!(await isGitRepo(input.path))) {
    throw new RepoGitError(
      `path exists but is not a git repository: ${input.path}` +
        (delivery === "pr" ? " (delivery is 'pr')" : ""),
    );
  }

  const detectedRemote = await detectOriginUrl(input.path);
  const detectedBranch = await detectDefaultBranch(input.path);

  let default_branch: string;
  if (input.explicit.default_branch) {
    const supplied = input.default_branch!;
    if (detectedBranch && supplied !== detectedBranch) {
      throw new RepoGitError(
        `default_branch '${supplied}' does not match the checkout at ${input.path} ` +
          `(detected '${detectedBranch}')`,
      );
    }
    default_branch = supplied;
  } else if (detectedBranch) {
    default_branch = detectedBranch;
  } else if (input.default_branch) {
    // Inherited from an existing row when PATCH didn't touch the field.
    default_branch = input.default_branch;
  } else {
    throw new RepoGitError(
      `could not detect default_branch at ${input.path}; set default_branch explicitly`,
    );
  }

  let git_remote: string | null;
  if (input.explicit.git_remote) {
    const supplied = input.git_remote ?? null;
    if (supplied != null && detectedRemote && supplied !== detectedRemote) {
      throw new RepoGitError(
        `git_remote '${supplied}' does not match origin at ${input.path} ` +
          `(detected '${detectedRemote}')`,
      );
    }
    if (supplied == null && detectedRemote && delivery === "pr") {
      // Explicit null with pr delivery — refuse rather than silently keeping null.
      throw new RepoGitError(
        `git_remote is required when delivery is 'pr' (origin at ${input.path} is '${detectedRemote}')`,
      );
    }
    git_remote = supplied;
  } else if (detectedRemote) {
    // Omit → fill from origin. Also fills when PATCH flips delivery to pr and the row had null.
    git_remote = detectedRemote;
  } else if (input.git_remote !== undefined) {
    git_remote = input.git_remote;
  } else {
    git_remote = null;
  }

  if (delivery === "pr" && !git_remote) {
    throw new RepoGitError(
      `delivery is 'pr' but ${input.path} has no origin remote — ` +
        `add an origin, set git_remote, or use delivery: 'commit'`,
    );
  }

  return { default_branch, git_remote, delivery };
}

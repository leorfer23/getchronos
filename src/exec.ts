import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const raw = promisify(execFile) as (
  cmd: string,
  args: string[],
  opts: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

// Every git/gh child process gets a sane default timeout + maxBuffer so a stalled process (network
// stall, auth prompt, gh hung on stdin) can never leave its caller's promise permanently pending —
// see PER-37 (a hung `gh pr view` inside pollDeliveries' sequential loop stalled the whole delivery
// poll, and every monitor tick after it, forever). Per-call opts override these defaults.
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024; // 10MB

export function execFileTimed(
  cmd: string,
  args: string[],
  opts: Partial<ExecFileOptionsWithStringEncoding> = {},
): Promise<{ stdout: string; stderr: string }> {
  return raw(cmd, args, {
    encoding: "utf8",
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
    ...opts,
  });
}

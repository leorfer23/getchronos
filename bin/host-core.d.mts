// Types for host-core.mjs, which stays plain JS so it runs before node_modules is whole.
export declare const HOST_LABEL: "sh.chronos.host";
export declare const PACKAGE_NAME: "getchronos";
export declare const SUPPORTED_NODE: { min: number; max: number };
export declare const NODE_FIX: string;
export type Check = { id: string; ok: boolean; level: "error" | "warn"; label: string; detail: string; fix?: string };
export type InstallKind = "git" | "npm" | "ephemeral" | "dev";
type Run = (cmd: string, args: string[]) => string;
export declare function nodeMajor(v: string | null | undefined): number;
export declare function shellPath(p: string, home?: string): string;
export declare function checkNode(version?: string, execPath?: string): Check;
export declare function checkDeps(pkgRoot: string, opts?: { appDir?: string; home?: string; load?: boolean }): Check[];
export declare function whichOnPath(name: string, pathVar?: string): string | null;
export declare function checkGit(opts?: { pathVar?: string; home?: string; run?: Run }): Check;
export declare function preflight(opts?: {
  pkgRoot?: string; appDir?: string; version?: string; execPath?: string; pathVar?: string; home?: string; run?: Run; load?: boolean;
}): Check[];
export declare function formatChecks(checks: Check[], opts?: { onlyFailures?: boolean }): string;
export declare function installKind(pkgRoot: string, hostHome: string): InstallKind;
export declare function stableNodePath(execPath?: string): string;
export declare function uninstall(opts?: {
  home?: string; hostHome?: string; purge?: boolean; uid?: number; run?: Run; launchAgentsDir?: string;
}): { done: string[]; left: string[] };

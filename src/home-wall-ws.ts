import { childEnv } from "./child-env.js";
import { homeWallFor, type HomeWall } from "./home-wall.js";
import { workspaces } from "./store.js";
import type { Workspace } from "./types.js";

/**
 * The home wall (home-wall.ts) for a workspace spawning on `configDir`, with what only the store
 * knows filled in: the workspace's own env (the config dirs it names) and its places on disk. Kept
 * apart from home-wall.ts so sandbox.ts can use that module without pulling the store in.
 */
export function workspaceHomeWall(ws: Workspace, configDir: string): HomeWall | null {
  return homeWallFor(ws, configDir, childEnv(ws), workspaces.ownPlaces(ws.id));
}

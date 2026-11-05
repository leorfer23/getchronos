/**
 * A Ship terminal (created_by "ship", src/ship-loop.ts) exists to put ONE merge/deploy question in
 * front of the operator. Its question is his: Robert is never woken to drive it, and its asks always
 * route to the operator, so nobody can say yes for him. Its own module, like inbox-guard.ts, so
 * robert-drive.ts and api.ts can check it without importing the loop.
 */
export const SHIP_BY = "ship";

export const isShipTerminal = (s: { created_by?: string | null } | null | undefined): boolean => s?.created_by === SHIP_BY;

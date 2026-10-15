import { reviews, runs, sessions, tickets } from "./store.js";

// Flow home view: the operator's single-glance board. Data assembly (flowData) reads only, so it
// unit-tests against a seeded db. Mirrors fleet.ts. queue rows are verbatim ticket rows; shipped rows
// are ticket rows enriched from the latest linked session / run / review.
export function flowData(now = new Date()) {
  const queue = tickets.flowQueue();
  const since = new Date(now.getTime() - 14 * 86400000).toISOString();
  const shipped = tickets.flowShipped(since, 50).map((t) => {
    const meta = sessions.latestMeta(t.id);
    return {
      ...t,
      summary: meta?.summary ?? null,
      tags: meta?.tags ?? null,
      verify_verdict: runs.verdictForTicket(t.id),
      review_state: reviews.byTicket(t.id)[0]?.state ?? null,
    };
  });
  const liveSessions = sessions.list({ status: "live" }).length;
  return {
    state: {
      running: runs.runningCount() + liveSessions,
      blocked: queue.filter((t) => t.status === "blocked").length,
      needs_you:
        shipped.filter((t) => t.status === "review").length +
        queue.filter((t) => t.status === "planned").length,
      live_sessions: liveSessions,
    },
    queue,
    shipped,
  };
}

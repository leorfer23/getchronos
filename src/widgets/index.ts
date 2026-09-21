/**
 * Live widgets: a small read-only view of the daemon that the Desk mounts as a card — on the Fleet
 * board, and inside a Robert reply that carries `::widget <name>::` on its own line.
 *
 * A widget is THREE things and no more: a reader here, a client module at
 * `static/desk-widgets/<name>.js`, and one line in each registry (this file's `WIDGETS`, and
 * `static/desk-widgets/index.js` for the board's order). That shape exists because widgets are
 * written in parallel: two new files plus one line each is a merge that never conflicts, whereas a
 * widget that needed its own route in api.ts or its own block in desk.html would collide with every
 * other one in flight.
 *
 * `data()` is READ-ONLY by contract. It is reached through an admin-authed GET that the page polls
 * on a timer and re-fires on bus events — anything with a side effect would run on a schedule
 * nobody asked for.
 */

export type Widget = {
  /** Registry key, url segment and file name: `[a-z0-9-]+`, matching static/desk-widgets/<name>.js. */
  name: string;
  /** The card's header, in the operator's words — not the name. */
  title: string;
  /** Bus topics whose events should make the mounted card refetch (see connectBus in desk.html). */
  topics?: string[];
  /** The JSON the client module renders. `q` is the card's own query string, strings only. */
  data: (q: Record<string, string>) => unknown | Promise<unknown>;
};

/**
 * Every widget the daemon serves. ADD ONE LINE — keep the import next to it, alphabetical, so four
 * agents appending on the same day land on different lines:
 *
 *   import fleet from "./fleet.js";
 *   export const WIDGETS: Widget[] = [fleet];
 */
import pulse from "./pulse.js";
import decide from "./decide.js";
import robert from "./robert.js";
import shipped from "./shipped.js";
export const WIDGETS: Widget[] = [pulse, decide, robert, shipped];

export const widgetByName = (name: string): Widget | null => WIDGETS.find((w) => w.name === name) ?? null;

/** GET /api/widgets — what exists, and what each one wants to be woken by. */
export function listWidgets(): { name: string; title: string; topics: string[] }[] {
  return WIDGETS.map((w) => ({ name: w.name, title: w.title, topics: w.topics ?? [] }));
}

/**
 * GET /api/widgets/:name — the card's payload. `null` means no such widget (404); a throw from
 * `data()` is the widget's own failure and becomes a 500 the card shows as one muted line.
 */
export async function readWidget(
  name: string,
  q: Record<string, string> = {},
): Promise<{ name: string; at: string; data: unknown } | null> {
  const w = widgetByName(name);
  if (!w) return null;
  return { name: w.name, at: new Date().toISOString(), data: await w.data(q) };
}

/**
 * The paragraph in Robert's Desk prompt that tells him live cards exist, with the registered names.
 *
 * Built at prompt-build time from WIDGETS rather than written into agents/robert/web.md, because a
 * hand-written list goes stale the first time someone adds a widget and Robert then names a card the
 * page cannot mount. An empty registry returns "" — a prompt section offering him nothing is worse
 * than no section at all.
 */
export function widgetPromptBlock(): string {
  if (!WIDGETS.length) return "";
  return (
    `LIVE VIEWS: you can put a live card in a Desk reply — \`::widget <name>::\` ALONE on its own ` +
    `line — and the page mounts it there, current and refreshing itself. Use one when the answer IS ` +
    `the data (what the fleet is doing right now, what it spent, what is queued) instead of typing ` +
    `numbers that are stale by the time he reads them; say your one line of judgement around it. ` +
    `Nothing else on that line, and never more than one card per answer.\n` +
    WIDGETS.map((w) => `- \`::widget ${w.name}::\` — ${w.title}`).join("\n") +
    `\n`
  );
}

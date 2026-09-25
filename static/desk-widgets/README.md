# Desk widgets

A **widget** is one live card: a small read of the daemon that the Desk keeps current. It shows up in
two places, unchanged in both —

- the **Fleet board** (the third view of the stage, next to Focus and Terminal, ⌘⇧F), and
- inside a **Robert reply**, wherever he puts `::widget <name>::` alone on a line.

It is deliberately a small contract. Four widgets are written in parallel; each one is two new files
plus **one line in each registry**, so they never collide, and none of them can break the page.

## Add one in four steps

Pick a `name` from `[a-z0-9-]` — it is the registry key, the file name and the url segment, all the
same string.

**1. The reader** — `src/widgets/<name>.ts`. Read-only: it is reached by an admin-authed `GET` that
the page polls on a timer.

```ts
import type { Widget } from "./index.js";

const spend: Widget = {
  name: "spend",
  title: "Spend today",            // the card's header, in the operator's words
  topics: ["session.ended"],       // bus topics that should make the card refetch (optional)
  data: (q) => ({ usd: todaysSpend(q.ws || null) }),   // q = the card's own query string
};
export default spend;
```

**2. One line in `src/widgets/index.ts`**:

```ts
import spend from "./spend.js";
export const WIDGETS: Widget[] = [spend];
```

**3. The module** — `static/desk-widgets/<name>.js`, an ES module with a default export:

```js
import { el, fmtAgo, PHASE_COLOR } from "./lib.js";

export default {
  name: "spend",
  title: "Spend today",
  refreshMs: 60000,                // how often the card refetches while it is on screen (min 2000)
  topics: ["session.ended"],       // same list as the reader's
  render(el_, data, ctx) { ... },  // fills el_ from data — see below
};
```

**4. One line in `static/desk-widgets/index.js`** — this is the board's running order:

```js
export const WIDGETS = ["spend"];
```

That is all. No route, no CSS, nothing in `desk.html`.

## `render(el, data, ctx)`

`el` is the card body (`.wbody`). `data` is whatever your reader returned. **Render idempotently**:
`render` is called again with fresh data on every refresh, so replace your output
(`el.replaceChildren(...)`) rather than appending to it.

Throwing is safe — the card shows one muted line and the rest of the board carries on — but a card
that throws shows nothing, so handle the empty case yourself.

`ctx` is the only thing you get from the page (it is `window.DeskWidgets`):

| key | what it is |
|---|---|
| `S` | the Desk's live state — `S.sessions`, `S.workspaces`, `S.active`. **Read it, never write it.** |
| `api(path, opts)` | admin-authed `fetch` of `/api…`, resolved as JSON; throws on a non-2xx |
| `esc(s)` | HTML-escape, for the rare case you build a string |
| `chipLabel(session)` | a session's short title, clipped the way the rail clips it |
| `toast(msg)` | the one-line notice at the bottom of the page |
| `stage(sessionId)` | put that terminal on the stage (leaves the board, like clicking the rail) |
| `pickWs(wsId)` | filter the chat log to that client (`null` = every client) — a view only, routing is automatic |
| `wsName(wsId)` / `wsColor(wsId)` | a client's name and its stable colour |
| `byId(sessionId)` | one session row out of `S.sessions` |

Everything else in the page is off limits, and will move.

## House style

- **Use the page's tokens**, never literal colours: `var(--ink)`, `var(--muted)`, `var(--faint)`,
  `var(--line)`, `var(--surface-2)`, `var(--accent)`, `var(--danger)`, `var(--warn)`. They are what
  makes dark mode work. For a terminal's phase use `PHASE_COLOR` / `PHASE_SOFT` from `./lib.js`, so
  your card agrees with the rail.
- **No animation.** The page's only clock is the 1Hz `body.blink` class; use it (`body.blink .mything
  { opacity:.3 }`) if something must pulse. An infinite CSS animation is a no.
- **Numbers line up**: the card body is already `font-variant-numeric: tabular-nums`.
- **One thing per card**, calm, and short enough that nothing scrolls inside it.
- Helpers in `./lib.js`: `el(tag, attrs, children)`, `fmtAgo(msOrIso)`, `fmtClock(iso)`,
  `PHASE_COLOR`, `PHASE_SOFT`.

## The wire

- `GET /api/widgets` → `[{ name, title, topics }]`
- `GET /api/widgets/<name>?…` → `{ name, at, data }` — `404` unknown, `500` if your `data()` threw
- `GET /desk-widgets/<name>.js` → the module (no-store; `[a-z0-9-]+.js` only)

`topics` are Chronos bus topics (`session.status`, `session.ended`, `run.ended`, …). Declare the ones
that mean your data changed; the page subscribes to them and refreshes the card, coalescing bursts.
Between events the card still polls on `refreshMs`, but only while it is actually on screen.

`example.js` here (with `src/widgets/example.ts`) is the shortest complete widget. It is in neither
registry on purpose — it exists so `src/desk-widgets.test.ts` can exercise the loader.

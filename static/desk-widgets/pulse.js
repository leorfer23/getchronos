// Fleet pulse — one band per terminal, its phase across the last window, "now" at the right edge.
//
// The reader is src/widgets/pulse.ts; everything here is drawing. Bands are plain flex children with
// a flex-grow proportional to their duration: no canvas (it would need its own resize handling and a
// second copy of the theme's colours) and no animation (the page's only clock is body.blink).
import { el, fmtAgo, PHASE_COLOR } from "./lib.js";

const KEY = "desk-widget-pulse-window";
const WINDOWS = [15, 60, 240];
const LABEL = { 15: "15m", 60: "1h", 240: "4h" };
const WORD = { your_turn: "your turn" };
// The four phases that mean the operator is the blocker read at full strength; the rest are quiet, so
// a board of working terminals does not shout. Same colours either way — this is weight, not hue.
const LOUD = new Set(["blocked", "decide", "review", "your_turn"]);
// The last payload whose window matched what the operator picked, per card body. Without it, flipping
// to 4h blanks or flashes the 1h view for one round trip — see render().
const seen = new WeakMap();

function win() {
  try {
    const n = Number(localStorage.getItem(KEY));
    if (WINDOWS.includes(n)) return n;
  } catch {}
  return 60;
}
function setWin(n) {
  try { localStorage.setItem(KEY, String(n)); } catch {}
}

function band(row) {
  const segs = row.segments || [];
  const kids = segs.map((s) => {
    const dur = Math.max(1, s.to - s.from);
    const loud = LOUD.has(s.phase);
    return el("i", {
      style: {
        flex: dur + " 1 0",
        minWidth: "2px",          // a 20-second flip inside a 4-hour window is still worth seeing
        background: PHASE_COLOR[s.phase] || "var(--faint)",
        opacity: loud ? "1" : ".4",
      },
    });
  });
  return el(
    "div",
    {
      style: {
        display: "flex", flex: "1 1 auto", height: "10px", margin: "0 10px",
        borderRadius: "5px", overflow: "hidden", background: "var(--surface-2)",
      },
    },
    // Nothing known yet reads as an empty trough rather than a wrong colour.
    kids.length ? kids : [],
  );
}

function rowEl(r, ctx) {
  const ws = ctx.wsName(r.workspace_id);
  const s = ctx.byId(r.id);
  const ended = r.phase === "ended";
  const who = el("div", { style: { flex: "0 0 34%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px" } }, [
    ws ? el("b", { style: { color: ctx.wsColor(r.workspace_id), fontWeight: "700" } }, [ws]) : null,
    ws ? " · " : null,
    el("span", { style: { color: "var(--ink)" } }, [s ? ctx.chipLabel(s) : r.title]),
  ]);
  const nowWord = el("div", { style: { flex: "0 0 auto", minWidth: "96px", textAlign: "right", fontSize: "13px" } }, [
    el("b", { style: { color: PHASE_COLOR[r.phase] || "var(--muted)", fontWeight: LOUD.has(r.phase) ? "750" : "600" } }, [
      WORD[r.phase] || r.phase,
    ]),
    " ",
    el("span", { style: { color: "var(--faint)" } }, [fmtAgo(r.since)]),
  ]);
  return el(
    "div",
    {
      style: { display: "flex", alignItems: "center", padding: "4px 0", cursor: "pointer", opacity: ended ? ".55" : "1" },
      title: (ws ? ws + " · " : "") + (s ? ctx.chipLabel(s) : r.title),
      onclick: () => ctx.stage(r.id),
    },
    [who, band(r), nowWord],
  );
}

function head(ctx, body) {
  const w = win();
  const pick = WINDOWS.map((n) =>
    el("span", {
      style: {
        cursor: "pointer", padding: "1px 6px", borderRadius: "6px", fontSize: "11.5px", fontWeight: "700",
        color: n === w ? "var(--ink)" : "var(--faint)",
        background: n === w ? "var(--surface-2)" : "transparent",
      },
      onclick: () => { setWin(n); pull(body, ctx, n); },
      text: LABEL[n],
    }),
  );
  return el("div", { style: { display: "flex", alignItems: "center", gap: "4px", marginBottom: "6px", fontSize: "11.5px", color: "var(--faint)" } }, [
    el("span", { text: "last " + LABEL[w] + " → now" }),
    el("span", { style: { marginLeft: "auto" } }, pick),
  ]);
}

function draw(body, data, ctx) {
  const rows = (data && data.rows) || [];
  body.replaceChildren(
    head(ctx, body),
    ...(rows.length
      ? rows.map((r) => rowEl(r, ctx))
      : [el("div", { class: "werr" }, ["nothing on the desk — no terminal has run in the last half hour"])]),
  );
}

// The card's query string is fixed at mount (mountWidget's opts.q), so the window toggle cannot ride
// on it: when the operator has picked anything but the reader's default the card does its own read.
function pull(body, ctx, w) {
  if (body._pulseBusy) return;
  body._pulseBusy = true;
  ctx
    .api("/widgets/pulse?window=" + w)
    .then((r) => {
      if (!body.isConnected || win() !== w) return;   // he flipped again while this was in flight
      seen.set(body, r.data);
      draw(body, r.data, ctx);
    })
    .catch(() => {})
    .finally(() => { body._pulseBusy = false; });
}

export default {
  name: "pulse",
  title: "Fleet pulse",
  refreshMs: 15000,
  topics: ["session.status", "session.started", "session.ended"],
  render(body, data, ctx) {
    const want = win();
    if (data && data.window === want) {
      seen.set(body, data);
      return draw(body, data, ctx);
    }
    draw(body, seen.get(body) || data, ctx);
    pull(body, ctx, want);
  },
};

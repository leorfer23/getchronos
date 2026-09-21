// "Shipped" — the client half of src/widgets/shipped.ts. What landed, newest day first, per client,
// with the burn beside it. Today and yesterday are open; the rest of the week is one line you click.
//
// Nothing here animates and nothing here invents a number: an item whose cost the daemon could not
// attribute unambiguously prints "—", and it prints "—" every refresh.
import { el, fmtClock } from "./lib.js";

const KINDS = { pr: "PR", deploy: "deploy", ticket: "ticket", worktree: "worktree" };

const usd = (n) => (typeof n === "number" ? "$" + n.toFixed(2) : "—");

const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// "2026-09-16" → a local Date, never Date.parse (which reads a bare date as UTC and can slip a day).
const dayDate = (key) => {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

function dayLabel(key, now) {
  const today = localDay(now);
  if (key === today) return "Today";
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key === localDay(y)) return "Yesterday";
  // "Mon 14" — assembled, not toLocaleDateString({weekday,day}), which renders "14 Mon" in plenty
  // of locales and reads as a different date entirely.
  const d = dayDate(key);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${d.getDate()}`;
}

// A 7-day bar chart, drawn by hand: el() makes HTML elements and SVG needs the namespace.
function spark(series, now) {
  const W = 92, H = 18, gap = 2;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("aria-hidden", "true");
  svg.style.display = "block";
  const max = Math.max(1, ...series.map((s) => s.count));
  const bw = (W - gap * (series.length - 1)) / Math.max(1, series.length);
  const today = localDay(now);
  series.forEach((s, i) => {
    const h = s.count ? Math.max(2, Math.round((s.count / max) * H)) : 1;
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", String(i * (bw + gap)));
    r.setAttribute("y", String(H - h));
    r.setAttribute("width", String(Math.max(1, bw)));
    r.setAttribute("height", String(h));
    r.setAttribute("rx", "1");
    r.setAttribute("fill", s.count ? (s.date === today ? "var(--accent)" : "var(--muted)") : "var(--line)");
    const t = document.createElementNS("http://www.w3.org/2000/svg", "title");
    t.textContent = `${s.date} · ${s.count}`;
    r.append(t);
    svg.append(r);
  });
  return svg;
}

function itemRow(it, ctx) {
  const s = it.session_id ? ctx.byId(it.session_id) : null;
  const byText = s ? ctx.chipLabel(s) : it.by || "";
  const label = it.url
    ? el("a", { href: it.url, target: "_blank", rel: "noreferrer", style: { color: "var(--accent)" } }, [it.label])
    : el("span", {}, [it.label]);
  return el(
    "div",
    { style: { display: "flex", gap: "8px", alignItems: "baseline", padding: "1px 0", fontSize: "14px" } },
    [
      el("span", {
        text: KINDS[it.kind] || it.kind,
        style: { color: "var(--faint)", fontSize: "11px", letterSpacing: ".06em", textTransform: "uppercase", minWidth: "58px" },
      }),
      el("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, [label]),
      byText
        ? el("span", {
            text: byText,
            title: byText,
            style: { color: "var(--muted)", fontSize: "12.5px", maxWidth: "140px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          })
        : null,
      el("span", { text: fmtClock(it.at), style: { color: "var(--faint)", fontSize: "12px" } }),
      el("span", {
        text: usd(it.usd),
        style: { color: it.usd === null ? "var(--faint)" : "var(--muted)", fontSize: "12.5px", minWidth: "52px", textAlign: "right" },
      }),
    ],
  );
}

function clientBlock(c, ctx) {
  return el(
    "div",
    { style: { borderLeft: `3px solid ${ctx.wsColor(c.workspace_id)}`, paddingLeft: "9px", margin: "5px 0 8px" } },
    [
      el("div", {
        text: ctx.wsName(c.workspace_id) || c.workspace_id,
        style: { fontSize: "12px", fontWeight: "700", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--muted)", marginBottom: "2px" },
      }),
      ...c.items.map((it) => itemRow(it, ctx)),
    ],
  );
}

function dayBlock(d, now, ctx) {
  return el("div", { style: { margin: "0 0 10px" } }, [
    el(
      "div",
      { style: { display: "flex", alignItems: "baseline", gap: "8px", borderBottom: "1px solid var(--line)", paddingBottom: "3px" } },
      [
        el("span", { text: dayLabel(d.date, now), style: { fontWeight: "700", fontSize: "14px" } }),
        el("span", {
          text: `${d.count} shipped · ${usd(d.total_usd)}`,
          style: { marginLeft: "auto", color: "var(--muted)", fontSize: "12.5px" },
        }),
      ],
    ),
    ...d.clients.map((c) => clientBlock(c, ctx)),
  ]);
}

export default {
  name: "shipped",
  title: "Shipped",
  refreshMs: 60000,
  topics: ["session.ended", "run.ended", "ticket.updated", "ticket.delivered", "note.updated"],

  render(body, data, ctx) {
    const now = data?.now ? new Date(data.now) : new Date();
    const days = Array.isArray(data?.days) ? data.days : [];
    const series = Array.isArray(data?.spark) ? data.spark : [];
    const total = series.reduce((a, s) => a + (s.count || 0), 0);

    // The card's own header row: the week's count and its 7-day shape. The card's <header> belongs
    // to the loader, so this line lives at the top of the body instead.
    const head = el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" } },
      [
        el("span", { text: `${total} in ${series.length || 7} days`, style: { color: "var(--muted)", fontSize: "13px" } }),
        el("span", { style: { marginLeft: "auto" } }, [spark(series, now)]),
      ],
    );

    if (!days.length) {
      body.replaceChildren(head, el("div", { class: "werr" }, ["nothing shipped yet this week"]));
      return;
    }

    const todayKey = localDay(now);
    const yKey = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
    const open = days.filter((d) => d.date === todayKey || d.date === yKey);
    const older = days.filter((d) => d.date !== todayKey && d.date !== yKey);

    const kids = [head, ...open.map((d) => dayBlock(d, now, ctx))];
    if (!open.length) kids.push(el("div", { class: "werr", style: { marginBottom: "8px" } }, ["nothing today or yesterday"]));

    if (older.length) {
      // Expansion survives a refresh: render() is called again with fresh data every minute, and a
      // section that closed itself under the operator's hand would be its own small betrayal.
      const shown = body._shipOpen === true;
      const n = older.reduce((a, d) => a + d.count, 0);
      const line = el(
        "button",
        {
          style: {
            border: "0", background: "none", padding: "2px 0", color: "var(--accent)",
            font: "inherit", fontSize: "13px", cursor: "pointer", textAlign: "left",
          },
          onclick: () => { body._shipOpen = !shown; this.render(body, data, ctx); },
        },
        [`${shown ? "▾" : "▸"} earlier this week — ${n} shipped`],
      );
      kids.push(line);
      if (shown) kids.push(...older.map((d) => dayBlock(d, now, ctx)));
    }

    body.replaceChildren(...kids);
  },
};

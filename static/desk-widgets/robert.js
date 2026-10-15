// "Robert's attention" — the one card that makes "Robert drives the fleet" a thing you can look at.
//
// Robert in the middle, the terminals around him, and an edge per way he is actually pointed at one:
// solid = a standing watch on a clock, dashed = a stop inside its grace that he will open, bold =
// the wake that got him last. A terminal with none of those still gets a hairline — he can see it,
// nothing is armed on it — because a graph that only draws the armed ones would make a quiet fleet
// look like a broken daemon, which is the exact confusion this card exists to end.
//
// Nothing here animates. The only moving thing is the 1Hz body.blink class dimming the edge of the
// terminal he is reading RIGHT NOW.
import { el, fmtAgo, PHASE_COLOR } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
/** el() builds HTML; SVG needs the namespace or the browser draws nothing and says nothing. */
function s(tag, attrs = {}, children = []) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

// The ring is deliberately small inside a wide box: the labels, not the nodes, are what runs out of
// room first, and a node at the 3 o'clock position needs ~120px of text to its right.
const W = 640, H = 300, CX = 320, CY = 148, RX = 140, RY = 100;

/** "now" · "in 34s" · "in 6m" · "in 2h" — the future half of the ladder fmtAgo walks backwards. */
export function inWhen(at, now = Date.now()) {
  const d = Math.round((Number(at) - now) / 1000);
  if (!isFinite(d) || d <= 0) return "now";
  if (d < 90) return "in " + d + "s";
  const m = Math.round(d / 60);
  return m < 60 ? "in " + m + "m" : "in " + Math.round(m / 60) + "h";
}

const clip = (t, n) => (String(t || "").length > n ? String(t).slice(0, n - 1) + "…" : String(t || ""));

/** Where each terminal sits on the ring. Starts at the top and goes clockwise, so the order the
 *  reader ranked them in is the order you read them in. */
export function ringPoint(i, total) {
  const a = (-90 + (i * 360) / Math.max(1, total)) * (Math.PI / 180);
  return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a), cos: Math.cos(a), sin: Math.sin(a) };
}

/** The edge Robert has to this terminal, and what it should say under its name. */
export function edgeOf(n) {
  if (n.armed) return { kind: "armed", color: "var(--warn)", width: 1.6, dash: "5 4", note: n.armed.why + " · opens " + inWhen(n.armed.fire_at) };
  if (n.watching)
    return {
      kind: "watch",
      color: "var(--accent)",
      width: 1.6,
      dash: null,
      note: n.watching.looking
        ? "looking now…"
        : "every " + n.watching.every_min + "m · next " + (n.watching.next_at ? inWhen(Date.parse(n.watching.next_at)) : "soon"),
    };
  if (n.woke) return { kind: "woke", color: "var(--muted)", width: 1.3, dash: null, note: "woke him " + fmtAgo(n.woke.at) + " ago · " + n.woke.why };
  return { kind: "idle", color: "var(--line)", width: 1, dash: null, note: "" };
}

const STYLE =
  ".rbt-look { opacity:1; } body.blink .rbt-look { opacity:.3; }" +
  ".rbt-node { cursor:pointer; } .rbt-node:hover .rbt-ring { stroke-width:3; }" +
  ".rbt-q li { cursor:pointer; }";

export default {
  name: "robert",
  title: "Robert's attention",
  refreshMs: 10000,
  topics: ["session.status", "session.updated", "session.ended", "agent.push"],

  render(host, data, ctx) {
    const d = data || {};
    const nodes = Array.isArray(d.nodes) ? d.nodes : [];
    const queue = Array.isArray(d.queue) ? d.queue : [];
    const sup = d.supervision || {};

    // ── the graph ──────────────────────────────────────────────────────────────────────────────
    const edges = [], marks = [];
    nodes.forEach((n, i) => {
      const p = ringPoint(i, nodes.length);
      const e = edgeOf(n);
      const last = d.last_wake && d.last_wake.id === n.id;
      edges.push(
        s("line", {
          x1: CX, y1: CY, x2: p.x, y2: p.y,
          stroke: last ? "var(--ink)" : e.color,
          "stroke-width": last ? 2.6 : e.width,
          "stroke-dasharray": e.dash,
          "stroke-linecap": "round",
          class: n.watching && n.watching.looking ? "rbt-look" : null,
        }),
      );
      // Beside the node when it is out to a side, clear above or below when it is at 12 or 6 — a
      // sub-label tucked under a top node lands ON the node, which is how the first draft read.
      const right = p.cos > 0.2, left = p.cos < -0.2;
      const tx = p.x + (right ? 14 : left ? -14 : 0);
      const anchor = right ? "start" : left ? "end" : "middle";
      const ty = right || left ? p.y + 3 : p.sin > 0 ? p.y + 25 : p.y - 27;
      const tySub = right || left ? ty + 12 : p.sin > 0 ? ty + 12 : ty + 12;
      marks.push(
        s("g", { class: "rbt-node", onclick: () => ctx.stage(n.id), role: "button", tabindex: "0" }, [
          s("title", {}, [(ctx.wsName(n.workspace_id) || "unscoped") + " · " + n.phase.replace("_", " ") + (e.note ? " · " + e.note : "")]),
          s("circle", { cx: p.x, cy: p.y, r: 9, fill: ctx.wsColor(n.workspace_id) || "var(--surface-2)", "fill-opacity": ".85" }),
          s("circle", { class: "rbt-ring", cx: p.x, cy: p.y, r: 9, fill: "none", stroke: PHASE_COLOR[n.phase] || "var(--line)", "stroke-width": 2 }),
          s("text", { x: tx, y: ty, "text-anchor": anchor, "font-size": "11.5", fill: "var(--ink)" }, [clip(ctx.chipLabel(ctx.byId(n.id) || n) || n.title, 16)]),
          e.note ? s("text", { x: tx, y: tySub, "text-anchor": anchor, "font-size": "10", fill: "var(--faint)" }, [clip(e.note, 24)]) : null,
        ]),
      );
    });

    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", style: "max-width:660px;height:auto;display:block;margin:0 auto", "aria-label": "Robert and the terminals he is pointed at" }, [
      ...edges,
      s("circle", { cx: CX, cy: CY, r: 24, fill: "var(--surface-2)", stroke: d.robert && d.robert.state === "busy" ? "var(--accent)" : "var(--line)", "stroke-width": 2 }),
      s("text", { x: CX, y: CY + 6, "text-anchor": "middle", "font-size": "17", "font-weight": "700", fill: "var(--ink)" }, ["R"]),
      s("text", { x: CX, y: CY + 40, "text-anchor": "middle", "font-size": "10.5", fill: "var(--faint)" }, ["Robert"]),
      ...marks,
    ]);

    // ── the rail: he'll open next ──────────────────────────────────────────────────────────────
    const rail = el("ol", { class: "rbt-q", style: { flex: "0 0 178px", margin: "0", padding: "0", listStyle: "none", fontSize: "12.5px" } },
      queue.slice(0, 6).map((q, i) => {
        const row = ctx.byId(q.id);
        return el("li", {
          style: { display: "flex", gap: "7px", alignItems: "baseline", padding: "3px 0", borderBottom: "1px solid var(--line)" },
          title: q.why + (q.queued ? " · queued, he takes it on the next drain" : " · armed, unless it moves first"),
          onclick: () => (row ? ctx.stage(q.id) : ctx.toast(q.why)),
        }, [
          el("span", { style: { color: "var(--faint)", minWidth: "12px" }, text: String(i + 1) }),
          el("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink)" },
            text: row ? ctx.chipLabel(row) : q.label || q.why }),
          el("span", { style: { color: q.queued ? "var(--accent)" : "var(--muted)" }, text: q.queued ? "now" : inWhen(q.fire_at) }),
        ]);
      }),
    );
    if (queue.length > 6) rail.append(el("li", { style: { color: "var(--faint)", padding: "3px 0" }, text: `+${queue.length - 6} more queued` }));
    const railBox = el("div", { style: { flex: "0 0 178px", minWidth: "0" } }, [
      el("div", { style: { fontSize: "11px", letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", fontWeight: "700", marginBottom: "4px" }, text: "he'll open next" }),
      queue.length ? rail : el("div", { style: { color: "var(--faint)", fontSize: "12.5px" }, text: "nothing queued" }),
    ]);

    // ── the one line underneath ────────────────────────────────────────────────────────────────
    const armedCount = nodes.filter((n) => n.armed).length + queue.filter((q) => q.queued).length;
    const watchCount = nodes.filter((n) => n.watching).length;
    const beacon = sup.beacon_age_ms == null ? "never" : Math.round(sup.beacon_age_ms / 60000) + "m";
    const who = d.robert || {};
    const mine =
      who.state === "busy"
        ? "on " + (ctx.wsName(who.ws) || "the fleet") + (who.since ? " since " + fmtAgo(who.since) : "")
        : "idle" + (who.last_turn_at ? " · last said " + fmtAgo(who.last_turn_at) + " ago" : "");
    // `ok` absent means the read failed or has not landed — saying "gap" there would cry wolf about
    // the one predicate whose whole value is that it is quiet until it isn't.
    const known = typeof sup.ok === "boolean";
    const verdict = el("div", { style: { marginTop: "10px", fontSize: "13px", color: "var(--muted)", display: "flex", flexWrap: "wrap", gap: "6px" } }, [
      el("b", { style: { color: !known ? "var(--muted)" : sup.ok ? "var(--ink)" : "var(--danger)" },
        text: !known ? "supervision unread" : sup.ok ? "supervision ok" : "supervision gap" }),
      el("span", { text: "· " + (sup.in_flight ?? 0) + " in flight · beacon " + beacon + " · Robert " + mine }),
      known && !sup.ok && sup.reason && el("span", { style: { color: "var(--danger)" }, text: "— " + sup.reason }),
    ]);

    const legend = el("div", { style: { marginTop: "6px", fontSize: "11.5px", color: "var(--faint)" },
      text: "solid = watching · dashed = armed wake · bold = what woke him last" + (d.more ? ` · +${d.more} more terminals` : "") });

    const calm =
      !nodes.length
        ? "no terminals on the desk — there is nothing for him to drive"
        : !watchCount && !armedCount
          ? "nothing armed — he's waiting on the fleet"
          : null;

    host.replaceChildren(
      ...[
        el("style", { text: STYLE }),
        el("div", { style: { display: "flex", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" } }, [
          el("div", { style: { flex: "1 1 300px", minWidth: "0" } }, [svg]),
          railBox,
        ]),
        calm ? el("div", { style: { marginTop: "8px", fontSize: "13px", color: "var(--muted)" }, text: calm }) : null,
        verdict,
        legend,
      ].filter(Boolean),
    );
  },
};

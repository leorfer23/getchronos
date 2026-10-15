// The handful of things every widget needs, so four of them do not each invent their own.
// Import what you use: `import { el, fmtAgo, PHASE_COLOR } from "./lib.js";`
//
// Nothing here touches the Desk's state or the network — that is what `ctx` is for (see README.md).

/**
 * One element, with attributes and children, without a template string — so a widget renders from
 * data it did not escape by hand. `el("div", { class: "x" }, ["text", el("b", {}, [n])])`.
 *
 * A string child becomes a text node, which is the point: a goal or a workspace name coming back
 * from the daemon is operator text, and it lands as text no matter what is in it.
 */
export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "text") n.textContent = String(v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

/** "now" · "14m" · "3h" · "2d" — the same ladder the rail's ages use, so nothing reads differently. */
export function fmtAgo(ms) {
  const n = typeof ms === "string" ? Date.parse(ms) : Number(ms);
  if (!isFinite(n)) return "";
  const m = Math.floor((Date.now() - (n > 1e12 ? n : n * 1000)) / 60000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h" : Math.floor(h / 24) + "d";
}

/** A wall-clock time from an ISO stamp, 24h, local — for a card whose rows are moments, not ages. */
export function fmtClock(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The seven phases of a terminal (src/term-status.ts) plus `ended`, in the colours the rail already
 * gives them (the `.ph.*` rules in desk.html). Values are var() references on purpose: a widget that
 * uses them is correct in both themes without knowing which one is on.
 */
export const PHASE_COLOR = {
  blocked: "var(--danger)",
  decide: "var(--p-decide)",
  review: "var(--accent)",
  your_turn: "var(--warn)",
  stalled: "var(--muted)",
  waiting: "var(--p-wait)",
  working: "var(--p-work)",
  ended: "var(--faint)",
};

/** The soft backgrounds behind those colours, for a chip. Phases the rail leaves unfilled get none. */
export const PHASE_SOFT = {
  blocked: "var(--danger-soft)",
  decide: "var(--p-decide-soft)",
  review: "var(--accent-soft)",
  your_turn: "var(--warn-soft)",
  stalled: "var(--surface-2)",
  waiting: "transparent",
  working: "transparent",
  ended: "transparent",
};

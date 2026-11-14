/* Workspace triggers on the Desk (src/ws-triggers.ts, `mc trigger`): one row per trigger in ⏰ Open loops,
 * with its on/off switch and what it last did. Minimal on purpose — adding and testing a trigger is
 * `mc trigger`; the Desk shows what is armed and lets the operator switch one off or back on.
 *
 * desk.html owns the dialog, the fetch and what a click does; this file owns how a row reads, so
 * src/desk-triggers.test.ts runs it in a vm. Everything a row shows came from an API row that an agent
 * may have written (its name, its command): every field is escaped here, never trusted.
 */
(function (root) {
  var ICON = { pr: "⇡", slack: "💬", email: "✉", check: "👁", command: "⚙", metric: "📈" };
  var DID = {
    opened: "opened a terminal", appended: "added to its live work", filed: "filed in the inbox", playbook: "ran its playbook",
    pending: "waiting for its busy terminal", skipped: "skipped", failed: "could not act",
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function clip(s, n) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  /** "opened a terminal · today 16:02 · 40m ago", or "never fired". `when` formats a time (desk.html's loopWhen). */
  function lastLine(t, when) {
    var f = t && t.last_fire;
    if (!f) return "never fired";
    var did = DID[f.outcome] || f.outcome;
    if (f.outcome === "skipped" && f.reason) did += " (" + clip(f.reason, 80) + ")";
    return "last: " + did + (when ? " · " + when(f.at) : "");
  }

  /**
   * One row. `h` = { wsBit(wsId) → html, when(iso) → text } from desk.html. The switch says what a click
   * does next to nothing else: data-tgsw carries the id, data-on whether it is on now.
   */
  function row(t, h) {
    h = h || {};
    var on = !!t.enabled;
    var meta = [];
    if (h.wsBit) meta.push(h.wsBit(t.workspace_id));
    meta.push("<span>" + esc(lastLine(t, h.when)) + "</span>");
    if (on && t.next_check_at && h.when) meta.push("<span>next look " + esc(h.when(t.next_check_at)) + "</span>");
    if (!on) meta.push('<span class="due">off' + (t.paused_reason ? ": " + esc(clip(t.paused_reason, 160)) : "") + "</span>");
    var sess = t.last_fire && t.last_fire.session_id ? t.last_fire.session_id : "";
    return '<div class="lp-row tg-row' + (on ? "" : " tg-off") + '" data-ltg="' + esc(t.id) + '" data-tgsess="' + esc(sess) + '">' +
      '<span class="lp-ico" title="' + esc(t.kind) + '">' + (ICON[t.kind] || "⚡") + "</span>" +
      "<div>" +
        '<div class="lp-t">' + esc(clip(t.name, 120)) + "</div>" +
        '<div class="lp-then"><b>when</b> ' + esc(clip(t.label, 200)) + " · <b>then</b> " + esc(clip(t.then, 200)) + "</div>" +
        (t.last_check ? '<div class="lp-then">last look: ' + esc(clip(t.last_check, 200)) + "</div>" : "") +
        '<div class="lp-meta">' + meta.join("") + "</div>" +
      "</div>" +
      '<div class="lp-acts"><button type="button" class="tg-sw' + (on ? " on" : "") + '" data-tgsw="' + esc(t.id) + '" data-on="' + (on ? "1" : "0") + '"' +
        ' aria-pressed="' + (on ? "true" : "false") + '" title="' + (on ? "Switch it off — it stops looking" : "Switch it on — it starts from now") + '">' +
        (on ? "On" : "Off") + "</button></div>" +
    "</div>";
  }

  /** Grouped by workspace, then by name — "per workspace" without a second list. */
  function sort(list) {
    return (list || []).slice().sort(function (a, b) {
      return String(a.workspace_id).localeCompare(String(b.workspace_id)) || String(a.name).localeCompare(String(b.name));
    });
  }

  root.DeskTriggers = { row: row, lastLine: lastLine, sort: sort, esc: esc };
})(typeof window !== "undefined" ? window : globalThis);

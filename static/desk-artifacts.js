/* Artifacts on the Desk (⋯ → 🗂 Artifacts, or P): every page agents published with `mc artifact put|ask`
 * (src/artifacts.ts), in the order the operator picks — latest activity, newest, A–Z, by project, or his
 * own. Dragging a row puts it where he drops it and switches the list to his own order ("Mine"), which is
 * kept in this browser; a page published after that lands on top until he moves it.
 *
 * desk.html owns the dialog, the fetch, the drag events and what a click does; this file owns the order
 * and how a row reads, so src/desk-artifacts.test.ts runs it in a vm. A title and a publisher are written
 * by an agent: every field is escaped here, never trusted.
 */
(function (root) {
  var MODES = ["recent", "new", "az", "project", "mine"];
  var LABEL = { recent: "Recent", new: "New", az: "A–Z", project: "Project", mine: "Mine" };
  var HINT = {
    recent: "Latest activity first — a new version or your answer moves a page up",
    new: "Newest first, by when it was published",
    az: "By title",
    project: "Grouped by project",
    mine: "Your order — drag a row to put it anywhere; a new page lands on top",
  };
  var MAX_SAVED = 2000;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ms(iso) {
    var n = Date.parse(iso || "");
    return isFinite(n) ? n : 0;
  }
  function norm(s) {
    return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
  /** "now" · "12m ago" · "3h ago" · "5d ago" · "12 Oct" past a month. */
  function ago(iso, now) {
    var t = ms(iso);
    if (!t) return "";
    var s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 30 * 86400) return Math.floor(s / 86400) + "d ago";
    var d = new Date(t);
    return d.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  }

  function mode(m) {
    return MODES.indexOf(m) >= 0 ? m : "recent";
  }
  /** What localStorage handed back, as a clean list of ids (anything else → empty). */
  function saved(v) {
    return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string" && x; }).slice(0, MAX_SAVED) : [];
  }

  function byRecent(a, b) {
    return ms(b.updated_at) - ms(a.updated_at) || ms(b.created_at) - ms(a.created_at);
  }
  function byNew(a, b) {
    return ms(b.created_at) - ms(a.created_at);
  }

  /**
   * The list in `m` order. `mine` = the saved ids, top first: a page it does not name yet (published
   * since) goes above every placed one, newest first. `wsName(id)` names a project for "project"; a
   * page with no project sorts last there.
   */
  function order(rows, m, mine, wsName) {
    var list = (rows || []).slice();
    var name = wsName || function (id) { return id || ""; };
    m = mode(m);
    if (m === "new") list.sort(byNew);
    else if (m === "az") {
      list.sort(function (a, b) {
        return String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" }) || byRecent(a, b);
      });
    } else if (m === "project") {
      list.sort(function (a, b) {
        var na = name(a.workspace_id) || "", nb = name(b.workspace_id) || "";
        if (!na !== !nb) return na ? -1 : 1;
        return na.localeCompare(nb, undefined, { sensitivity: "base" }) || String(a.workspace_id || "").localeCompare(String(b.workspace_id || "")) || byRecent(a, b);
      });
    } else if (m === "mine") {
      var pos = Object.create(null);
      saved(mine).forEach(function (id, i) { if (!(id in pos)) pos[id] = i; });
      list.sort(function (a, b) {
        var pa = a.id in pos ? pos[a.id] : -1, pb = b.id in pos ? pos[b.id] : -1;
        if (pa < 0 && pb < 0) return byNew(a, b);
        if (pa < 0) return -1;
        if (pb < 0) return 1;
        return pa - pb;
      });
    } else list.sort(byRecent);
    return list;
  }

  /** Every word of `q` appears in the title, the publisher or the project — case and accents ignored. */
  function matches(a, q, wsName) {
    var words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    var hay = norm([a.title, a.created_by, wsName ? wsName(a.workspace_id) : ""].join(" "));
    return words.every(function (w) { return hay.indexOf(w) >= 0; });
  }

  /**
   * Drop `id` before (or, with `after`, after) `target` within what is on screen, and return the new
   * saved order. `shown` = the ids on screen, top first; `mine` = the stored order, which can name pages
   * that are NOT on screen (filtered out, another client under the client lock, gone). Those keep their
   * places: only the slots the shown pages hold are refilled, so dragging inside a filtered list never
   * reshuffles what you cannot see. A page on screen that the stored order does not know yet is taken
   * where it shows — new ones are on top in "Mine", so that is where they are seeded.
   */
  function drop(mine, shown, id, target, after) {
    var list = saved(mine);
    shown = (shown || []).filter(function (x) { return typeof x === "string" && x; });
    if (shown.indexOf(id) < 0) return list;
    var next = shown.slice();
    if (target != null && target !== id && shown.indexOf(target) >= 0) {
      next = shown.filter(function (x) { return x !== id; });
      next.splice(next.indexOf(target) + (after ? 1 : 0), 0, id);
    }
    var known = Object.create(null);
    list.forEach(function (x) { known[x] = 1; });
    var base = shown.filter(function (x) { return !(x in known); }).concat(list);
    var onScreen = Object.create(null);
    shown.forEach(function (x) { onScreen[x] = 1; });
    var seen = Object.create(null), k = 0, out = [];
    base.forEach(function (x) {
      if (x in seen) return;
      seen[x] = 1;
      out.push(x in onScreen ? next[k++] : x);
    });
    return out.slice(0, MAX_SAVED);
  }

  /** One row. `h` = { wsBit(wsId) → html, who(name) → text, now } from desk.html; `m` = the sort on screen. */
  function row(a, h, m) {
    h = h || {};
    var asks = !!a.ask_id;
    var done = a.status !== "open";
    var ico = asks ? (done ? "✓" : "?") : "▤";
    var icoCls = asks ? (done ? " done" : " ask") : "";
    var icoTip = asks ? (done ? "a question — answered" : "a question — waiting on you") : "a page";
    var meta = [];
    if (m !== "project" && h.wsBit) {
      var w = h.wsBit(a.workspace_id);
      if (w) meta.push(w);
    }
    if (a.created_by) meta.push("<span>" + esc(h.who ? h.who(a.created_by) : a.created_by) + "</span>");
    if (asks && !done) meta.push('<span class="due">waiting on you</span>');
    else if (a.status === "answered") meta.push("<span>answered</span>");
    if (Number(a.version) > 1) meta.push("<span>v" + Math.floor(Number(a.version)) + "</span>");
    var when = m === "new" ? a.created_at : a.updated_at;
    var age = ago(when, h.now);
    if (age) meta.push("<span>" + (m === "new" ? "published " : "") + esc(age) + "</span>");
    return (
      '<div class="lp-row ag-row" draggable="true" tabindex="0" data-agid="' + esc(a.id) + '">' +
      '<span class="lp-ico' + icoCls + '" title="' + icoTip + '">' + ico + "</span>" +
      '<div><div class="lp-t">' + esc(a.title || "(untitled)") + '</div><div class="lp-meta">' + meta.join("") + "</div></div>" +
      '<span class="ag-grip" title="Drag to put it where you want" aria-hidden="true">⋮⋮</span>' +
      "</div>"
    );
  }

  /** The rows, already in order; "project" puts one header above each project with its count. */
  function render(list, m, h) {
    h = h || {};
    list = list || [];
    var name = h.wsName || function () { return ""; };
    var counts = Object.create(null);
    if (m === "project") list.forEach(function (a) { var w = a.workspace_id || ""; counts[w] = (counts[w] || 0) + 1; });
    var out = [], last = null;
    list.forEach(function (a) {
      if (m === "project") {
        var w = a.workspace_id || "";
        if (w !== last) {
          last = w;
          out.push('<div class="lp-sec">' + esc(name(w) || "No project") + '<span class="n">' + counts[w] + "</span></div>");
        }
      }
      out.push(row(a, h, m));
    });
    return out.join("");
  }

  root.DeskArtifacts = { MODES: MODES, LABEL: LABEL, HINT: HINT, mode: mode, saved: saved, order: order, matches: matches, drop: drop, row: row, render: render, ago: ago, esc: esc };
})(typeof window !== "undefined" ? window : globalThis);

/* The client lock — one client on the whole Desk, for when the screen is shared.
 *
 * Locked, the page must not be able to draw another client even by accident, so the lock is not a
 * filter each surface remembers to apply: it is a lens on the two doors everything comes through.
 * Every GET the page makes goes through `lens()`, every bus event through `passes()`, and what
 * reaches the page is a daemon that only ever had one client. The rail, the pickers, the chat,
 * the inbox, jobs, widgets, the log — none of them know the lock exists, which is why a surface
 * added next month is covered the day it ships.
 *
 * Fail closed. A row that names another client is dropped everywhere. A row that names NO client
 * (a terminal opened outside a workspace, a "fleet" turn of Robert's) is dropped too, except on a
 * read that is already addressed to one thing (/sessions/<id>/…, /runs?job_id=…), where a blank
 * workspace_id is a sub-row of something in scope and not a stranger.
 *
 * Never lens what the page writes back: a list the Desk PATCHes whole (a host's policy.deny) has to
 * arrive whole, or saving one client's switch would silently drop every other client's.
 *
 * desk.html owns the chip, the menu and the reload; this file owns what "in scope" means, and
 * src/desk-scope.test.ts runs it in a vm against the shapes the daemon actually returns.
 */
(function (root) {
  var KEY = "desk-lock";
  var MASK = "another workspace";
  // Reads addressed to ONE thing: its sub-rows may carry no workspace of their own.
  // (/jobs/board and /jobs/runs are lists across clients, not a job.)
  var ADDRESSED = /^\/(?:sessions|runs|jobs(?!\/(?:board|runs)\b)|workspaces|jots|notes|tickets|asks|artifacts|launches|repos)\/[^/?]+|^\/runs\?job_id=|^\/notes\?workspace=/;

  function isObj(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function base(p) { return String(p || "").replace(/\/+$/, "").split("/").pop() || ""; }

  /** The stored lock: { id, name, slug, dir, i } or null. Unreadable storage is "not locked". */
  function get() {
    try {
      var v = JSON.parse(root.localStorage.getItem(KEY) || "null");
      return isObj(v) && typeof v.id === "string" && v.id ? v : null;
    } catch (x) { return null; }
  }
  /**
   * Lock to a workspace row (as GET /desk returns it), or pass null to show every client again.
   * `i` is its place in the full list — its colour — which a one-row list can no longer tell.
   */
  function set(w, i) {
    try {
      if (!w) return void root.localStorage.removeItem(KEY);
      root.localStorage.setItem(KEY, JSON.stringify({ id: w.id, name: w.name || "", slug: w.slug || "", dir: base(w.config_dir || w.dir), i: i > 0 ? i : 0 }));
    } catch (x) {}
  }

  function keepRow(v, lock, strict) {
    if (!isObj(v) || !("workspace_id" in v)) return true;
    return v.workspace_id === lock.id || (!strict && v.workspace_id == null);
  }
  /** Deep copy of `v` without the rows that belong to anyone else. Never mutates what it was given. */
  function prune(v, lock, strict, key) {
    if (Array.isArray(v)) {
      var rows = v;
      if (key === "shared_with") rows = rows.filter(function (id) { return id === lock.id; });
      // A list of workspaces themselves ({ id, slug, name }) — the pickers and the tab bars.
      else if (key === "workspaces") rows = rows.filter(function (w) { return !isObj(w) || "workspace_id" in w || !("id" in w) || w.id === lock.id; });
      rows = rows.filter(function (r) { return keepRow(r, lock, strict); });
      return rows.map(function (r) {
        var out = prune(r, lock, strict, null);
        // A repo shared INTO this client names the client it came from.
        if (key === "shared_repos" && isObj(out)) { out.owner_name = MASK; out.owner_slug = MASK; }
        return out;
      });
    }
    if (!isObj(v)) return v;
    var o = {};
    for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = prune(v[k], lock, strict, k);
    return o;
  }
  function onlyKey(map, id) {
    var o = {};
    if (isObj(map) && id in map) o[id] = map[id];
    return o;
  }
  /** A Mac's checklist beyond its client rows: its GitHub logins and its own veto list name clients too. */
  function hostCut(h, lock) {
    if (!isObj(h) || !isObj(h.checklist)) return;
    h.checklist.gh = [];
    h.checklist.veto = (h.checklist.veto || []).filter(function (s) { return s === lock.slug || s === lock.id; });
  }
  function sum(rows, k) { return rows.reduce(function (n, r) { return n + (Number(r[k]) || 0); }, 0); }

  /**
   * What the locked page is allowed to see of one GET. `path` is the page's own ("/desk",
   * "/jobs/board?…"), `lock` is get(). Unlocked it hands back the same object, untouched.
   */
  function lens(path, data, lock) {
    if (!lock || data == null || typeof data !== "object") return data;
    var p = String(path || "");
    var route = p.split("?")[0];

    var d = prune(data, lock, !ADDRESSED.test(p), null);
    // Computers: GET /hosts is the list, a PATCH answers with one. (policy.deny is slugs, which the
    // prune leaves alone — see the header: that list is written back whole.)
    if (route === "/hosts" || /^\/hosts\/[^/]+$/.test(route)) (Array.isArray(d.hosts) ? d.hosts : [d]).forEach(function (h) { hostCut(h, lock); });
    if (route === "/desk") d.inbox = onlyKey(data.inbox, lock.id);
    if (route === "/inbox" && isObj(d)) d.counts = onlyKey(data.counts, lock.id);
    if (route === "/jobs/board") {
      d.days_by_ws = onlyKey(data.days_by_ws, lock.id);
      d.days = d.days_by_ws[lock.id] || [];
    }
    // The day's totals were added up across every client: add them up again over what is left.
    if (route === "/desk/log" && Array.isArray(d.terminals)) {
      var t = d.terminals;
      d.totals = Object.assign({}, data.totals, {
        terminals: t.length, minutes: sum(t, "minutes"), turns: sum(t, "turns"), cost_usd: sum(t, "cost_usd"),
        lines_added: sum(t, "lines_added"), lines_removed: sum(t, "lines_removed"), blocked: sum(t, "blocked_count"),
      });
    }
    // Spend is one number for the whole shop; there is no honest per-client half of it here.
    if (route === "/desk/cockpit") d.spend = null;
    // A Claude meter is named after its profile dir, and a profile is a client.
    if (route === "/usage" && Array.isArray(d.meters)) {
      d.meters = d.meters.filter(function (m) { return m.cli !== "claude" || (!!lock.dir && m.scope === lock.dir); });
    }
    return d;
  }

  /** May a locked page act on this bus event? Session-only events are dropped later, by byId(). */
  function passes(e, lock) {
    if (!lock || !e) return true;
    if (e.workspace_id !== undefined && e.workspace_id !== lock.id) return false;
    // Robert's thread: every row says which project's Robert spoke (null = the whole shop).
    if (/^agent\./.test(e.topic || "") && e.topic !== "agent.state" && e.ws !== lock.id) return false;
    return true;
  }

  root.DeskScope = { KEY: KEY, MASK: MASK, get: get, set: set, lens: lens, passes: passes, prune: prune };
})(typeof window !== "undefined" ? window : globalThis);

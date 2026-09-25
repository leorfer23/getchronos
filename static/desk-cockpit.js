/* The Robert panel — the control half of the Desk's Robert pane.
 *
 * The chat is the conversation; this is what you glance at beside it: the questions waiting on you,
 * the terminals that stopped (blocked, idle, done), the PRs they opened with their CI, and today —
 * follow-ups due, spend, how much of each subscription is gone. One compact row per thing, one or two
 * buttons each, a count on every header, and a section with nothing in it is not drawn at all.
 *
 * It owns no data. The page already holds the terminals, the notes and the usage meter live off the
 * bus; the questions are the Ask widget's (static/ask-card.js, answered through it); only the PRs and
 * the spend come from GET /desk/cockpit (src/desk-cockpit.ts). Every button goes through a door that
 * already exists — /sessions/:id/input, /sessions/:id/kill, /tickets/:id/merge-pr, /jots/:id/follow-up/now.
 *
 * ctx = { el, api, toast, esc, arm, isOpen(), terminals(), jots(), isLive(id), usage(), ask (AskCard),
 *         open(id), input(id, body), close(id), openFollow(j), reload() }
 */
(function (root) {
  var C = null;
  var D = { prs: [], spend: null, at: 0 };
  var st = { open: null, more: {}, hidden: new Map(), t: 0, ft: 0, pend: false };
  var CAP = 4; // rows a section shows before "+N more"
  var HIDE_MS = 8000; // a row you just acted on stays gone this long, while the bus catches up

  // ── pure: what each section holds ──────────────────────────────────────────────────────────────
  var TERM_PHASES = { blocked: 0, decide: 1, stalled: 2, your_turn: 3, review: 4 };
  /** Terminals that stopped and want something, minus the ones already listed as a question. */
  function pickTerms(list, askKeys) {
    return (list || []).filter(function (t) { return t.phase in TERM_PHASES && !askKeys.has("term:" + t.id); })
      .sort(function (a, b) { return TERM_PHASES[a.phase] - TERM_PHASES[b.phase] || (a.since || 0) - (b.since || 0); });
  }
  /** Notes whose follow-up lands today (or is overdue, or is being worked right now). */
  function todayFollowUps(jots, now, isLive) {
    var end = new Date(now); end.setHours(23, 59, 59, 999);
    return (jots || []).filter(function (j) {
      if (j.status === "done") return false;
      if (!j.follow_up_at) return !!(j.follow_up_session && isLive(j.follow_up_session));
      return Date.parse(j.follow_up_at) <= end.getTime();
    }).sort(function (a, b) { return (a.follow_up_at ? Date.parse(a.follow_up_at) : Infinity) - (b.follow_up_at ? Date.parse(b.follow_up_at) : Infinity); });
  }

  // ── small helpers ──────────────────────────────────────────────────────────────────────────────
  function e(s) { return C.esc(s); }
  function ago(ms) {
    if (!ms) return "";
    var m = Math.floor((Date.now() - ms) / 60000);
    return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.floor(m / 60) + "h" : Math.floor(m / 1440) + "d";
  }
  function when(iso) {
    var ms = Date.parse(iso) - Date.now(), m = Math.round(Math.abs(ms) / 60000);
    if (ms <= 0) return m < 1 ? "due now" : "due " + (m < 60 ? m + "m" : Math.round(m / 60) + "h");
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function hidden(k) { var t = st.hidden.get(k); return t && Date.now() - t < HIDE_MS; }
  function hide(k) { st.hidden.set(k, Date.now()); soon(); }
  function row(k, dot, text, meta, btns, tip) {
    return '<div class="ck-row" data-k="' + e(k) + '"' + (tip ? ' title="' + e(tip) + '"' : "") + '>' +
      '<span class="dot ' + dot + '"></span><span class="ck-t">' + text + '</span>' +
      (meta ? '<span class="ck-m">' + e(meta) + "</span>" : "") +
      (btns ? '<span class="ck-b">' + btns + "</span>" : "") + "</div>";
  }
  function btn(act, label, tip, cls) {
    return '<button type="button" class="ck-btn' + (cls ? " " + cls : "") + '" data-act="' + act + '"' + (tip ? ' title="' + e(tip) + '"' : "") + ">" + e(label) + "</button>";
  }
  function section(key, name, rows, extra) {
    if (!rows.length && !extra) return "";
    var more = st.more[key], shown = more ? rows : rows.slice(0, CAP);
    return '<section class="ck-sec" data-sec="' + key + '"><h4><span>' + e(name) + "</span>" + (rows.length ? "<b>" + rows.length + "</b>" : "") + "</h4>" +
      (extra || "") + shown.join("") +
      (rows.length > CAP ? '<button type="button" class="ck-more" data-more="' + key + '">' + (more ? "fewer" : "+" + (rows.length - CAP) + " more") + "</button>" : "") +
      "</section>";
  }

  // ── the sections ───────────────────────────────────────────────────────────────────────────────
  var items = new Map(); // row key → what it stands for, for the click handler
  function askRows() {
    if (!C.ask.items) return [];
    return C.ask.items().filter(function (it) { return !hidden(it.key); }).map(function (it) {
      items.set(it.key, { kind: "ask", it: it });
      var ops = it.options || [];
      var b = ops.length && ops.length <= 2
        ? ops.map(function (o, i) { return btn("opt:" + i, o.length > 18 ? o.slice(0, 17) + "…" : o, o); }).join("")
        : btn("expand", st.open === it.key ? "Close" : "Answer", "Answer in place");
      var html = row(it.key, "decide", "<b>" + e(it.question) + '</b> <span class="ck-s">' + e(it.who) + "</span>", ago(it.at), b, it.who + " asks: " + it.question);
      if (st.open === it.key) html += '<div class="ck-card" data-card="' + e(it.key) + '"></div>';
      return html;
    });
  }
  var PH_DOT = { blocked: "blocked", decide: "decide", stalled: "waiting", your_turn: "waiting", review: "done" };
  var PH_SAY = { blocked: "blocked", decide: "decide", stalled: "stalled", your_turn: "your turn", review: "done" };
  function termRows(askKeys) {
    return pickTerms(C.terminals(), askKeys).filter(function (t) { return !hidden("t:" + t.id); }).map(function (t) {
      items.set("t:" + t.id, { kind: "term", t: t });
      var b = t.phase === "review" ? btn("close", "Close", "Goal done — close this terminal (click twice)")
        : t.phase === "your_turn" || t.phase === "stalled" ? btn("nudge", "Continue", "Type “continue” into it")
        : btn("open", "Open", "Put it on the stage");
      return row("t:" + t.id, PH_DOT[t.phase], "<b>" + e(t.title) + "</b> " + (t.line ? '<span class="ck-s">' + e(t.line) + "</span>" : ""),
        PH_SAY[t.phase] + " · " + ago(t.since), b, (t.ws ? t.ws + " · " : "") + t.title);
    });
  }
  function prRows() {
    return D.prs.filter(function (p) { return !hidden("pr:" + p.url); }).map(function (p) {
      items.set("pr:" + p.url, { kind: "pr", p: p });
      var dot = p.ci === "passing" ? "ok" : p.ci === "failing" ? "bad" : p.ci === "pending" ? "pend" : "none";
      var ci = p.ci === "passing" ? "green" : p.ci === "failing" ? "CI red" : p.ci === "pending" ? "CI running" : "no CI";
      var b = "";
      if (p.merge) b += btn("merge", "Merge", "Squash-merge it (click twice)", "go");
      else if (p.ci === "passing" && p.auto_merge) ci = "auto-merging";
      if (p.ci === "failing" && p.session_id && C.isLive(p.session_id)) b += btn("fix", "Fix", "Tell its terminal to fix the failing checks");
      b += '<a class="ck-btn" href="' + e(p.url) + '" target="_blank" rel="noopener" title="Open on GitHub">Open ↗</a>';
      var name = p.repo.split("/").pop() + "#" + p.num;
      return row("pr:" + p.url, dot, "<b>" + e(name) + "</b> " + (p.title ? '<span class="ck-s">' + e(p.title) + "</span>" : ""), ci, b, p.note || p.url);
    });
  }
  function fuRows() {
    return todayFollowUps(C.jots(), Date.now(), C.isLive).filter(function (j) { return !hidden("j:" + j.id); }).map(function (j) {
      items.set("j:" + j.id, { kind: "jot", j: j });
      var live = !j.follow_up_at;
      var due = !live && Date.parse(j.follow_up_at) <= Date.now();
      var b = live ? btn("fuopen", "Open", "A follow-up terminal is on it") : btn("funow", "Now", "Open the follow-up terminal now");
      return row("j:" + j.id, live ? "working" : due ? "waiting" : "none", "⏰ " + e(j.title), live ? "on it" : when(j.follow_up_at), b,
        "Follow-up" + (j.follow_up_check ? " — check: " + j.follow_up_check : "") + " · click to reschedule");
    });
  }
  function todayLine() {
    var bits = [];
    if (D.spend) bits.push('<span class="ck-spend" title="Runs $' + D.spend.runs_usd.toFixed(2) + " · terminals $" + D.spend.sessions_usd.toFixed(2) + '"><b>$' + D.spend.today_usd.toFixed(2) + "</b> today</span>");
    (C.usage() || []).forEach(function (u) {
      bits.push('<span class="ck-u ' + (u.level || "") + '" title="' + e(u.tip) + '">' + e(u.name) + " <b>" + Math.round(u.pct) + '%</b><i><i style="width:' + Math.min(100, u.pct) + '%"></i></i></span>');
    });
    return bits.length ? '<div class="ck-today">' + bits.join("") + "</div>" : "";
  }

  // ── paint ──────────────────────────────────────────────────────────────────────────────────────
  function render() {
    st.t = 0;
    if (!C || !C.isOpen()) { st.pend = true; return; }
    // Never repaint under a field you are typing in (an answer box): pick it up once you leave it.
    var a = document.activeElement;
    if (a && C.el.contains(a) && (a.tagName === "INPUT" || a.tagName === "TEXTAREA")) { st.pend = true; return; }
    st.pend = false;
    items.clear();
    var asks = askRows();
    var askKeys = new Set((C.ask.items ? C.ask.items() : []).map(function (it) { return it.key; }));
    var html = section("asks", "Questions", asks) + section("terms", "Terminals", termRows(askKeys)) +
      section("prs", "PRs", prRows()) + section("today", "Today", fuRows(), todayLine());
    if (html === C.el._html) return;
    C.el._html = html;
    // The panel growing or shrinking moves the conversation under it; the page keeps its newest line in view.
    (C.pin || function (f) { f(); })(function () {
      C.el.innerHTML = html;
      C.el.hidden = !html;
      if (st.open) {
        var card = C.el.querySelector('[data-card="' + st.open + '"]');
        var it = items.get(st.open);
        if (card && it) { card.appendChild(C.ask.host(it.it)); }
        else st.open = null;
      }
    });
  }
  function soon() { if (!st.t) st.t = setTimeout(render, 120); }

  async function fetchNow() {
    clearTimeout(st.ft); st.ft = 0;
    if (!C || !C.isOpen() || document.visibilityState === "hidden") return;
    try {
      var d = await C.api("/desk/cockpit");
      D.prs = d.prs || []; D.spend = d.spend || null; D.at = Date.now();
      soon();
    } catch (x) {}
  }
  function fetchSoon(ms) { if (!st.ft) st.ft = setTimeout(fetchNow, ms == null ? 2000 : ms); }

  // ── clicks ─────────────────────────────────────────────────────────────────────────────────────
  async function act(name, k, b) {
    var x = items.get(k); if (!x) return;
    if (x.kind === "ask") {
      if (name === "expand") { st.open = st.open === k ? null : k; C.el._html = null; render(); var f = C.el.querySelector(".ck-card .ak-f input"); if (f) f.focus(); return; }
      if (name.indexOf("opt:") === 0) { hide(k); return C.ask.answer(x.it, Number(name.slice(4)), null); }
    }
    if (x.kind === "term") {
      if (name === "open") return C.open(x.t.id);
      if (name === "nudge") { hide(k); return C.input(x.t.id, { text: "continue", enter: true }); }
      if (name === "close") return C.arm(b, "sure?", function () { hide(k); C.close(x.t.id); });
    }
    if (x.kind === "pr") {
      if (name === "fix") { hide(k); C.toast("asked it to fix CI"); return C.input(x.p.session_id, { text: "CI is failing on " + x.p.url + " — read the failing checks, fix them and push.", enter: true }); }
      if (name === "merge") return C.arm(b, "merge?", async function () {
        b.disabled = true; b.textContent = "merging…";
        try { await C.api("/tickets/" + x.p.merge.ticket_id + "/merge-pr", { method: "POST" }); hide(k); C.toast("merged " + x.p.repo.split("/").pop() + "#" + x.p.num); fetchSoon(500); }
        catch (err) { b.disabled = false; b.textContent = "Merge"; C.toast(String(err.message || err).slice(0, 140)); }
      });
    }
    if (x.kind === "jot") {
      if (name === "fuopen") return C.open(x.j.follow_up_session);
      if (name === "funow") {
        b.disabled = true; b.textContent = "opening…";
        try { var r = await C.api("/jots/" + x.j.id + "/follow-up/now", { method: "POST", body: "{}" }); hide(k); await C.reload(); if (r && r.session) C.open(r.session.id); }
        catch (err) { b.disabled = false; b.textContent = "Now"; C.toast(String(err.message || err).slice(0, 140)); }
        return;
      }
      if (name === "row") return C.openFollow(x.j);
    }
    if (name === "row" && x.kind === "term") return C.open(x.t.id);
    if (name === "row" && x.kind === "ask") return act("expand", k);
  }

  function init(ctx) {
    C = ctx;
    C.el.addEventListener("click", function (ev) {
      var m = ev.target.closest("[data-more]");
      if (m) { st.more[m.dataset.more] = !st.more[m.dataset.more]; C.el._html = null; return render(); }
      if (ev.target.closest("a, .ck-card")) return;
      var r = ev.target.closest(".ck-row"); if (!r) return;
      var b = ev.target.closest("[data-act]");
      act(b ? b.dataset.act : "row", r.dataset.k, b);
    });
    // The expanded card answers through the Ask widget's own wiring; the row then steps aside while
    // the answer lands, so a stale copy of the card is never redrawn over the one being sent.
    if (C.ask.wire) C.ask.wire(C.el);
    function answered(ev) {
      var card = ev.target.closest && ev.target.closest(".ck-card");
      if (!card) return;
      if (ev.type === "click" && !ev.target.closest("[data-akopt]")) return;
      if (ev.type === "submit" && !(ev.target.elements && ev.target.elements.a && ev.target.elements.a.value.trim())) return;
      var k = card.dataset.card;
      setTimeout(function () { if (document.activeElement && C.el.contains(document.activeElement)) document.activeElement.blur(); st.open = null; hide(k); }, 400);
    }
    C.el.addEventListener("click", answered, true);
    C.el.addEventListener("submit", answered, true);
    C.el.addEventListener("focusout", function () { setTimeout(function () { if (st.pend) soon(); }, 0); });
    if (C.ask.onChange) C.ask.onChange(soon);
    // PR state has no bus event of its own; it is re-read on a slow clock while the pane is open.
    setInterval(function () { fetchNow(); soon(); }, 60000);
  }
  /** The pane opened (or the terminals moved): repaint, and read the PRs again soon. */
  function wake() { soon(); if (!D.at || Date.now() - D.at > 15000) fetchNow(); }

  root.DeskCockpit = { init: init, render: soon, wake: wake, refresh: fetchSoon, pickTerms: pickTerms, todayFollowUps: todayFollowUps, TERM_PHASES: TERM_PHASES };
})(typeof window !== "undefined" ? window : globalThis);

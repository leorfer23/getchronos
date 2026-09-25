/* The Ask widget — a question for the operator, as one card he answers where he reads it.
 *
 * Shared by desk.html and phone.html (no build step, so a plain script on window, like
 * desk-quick-actions.js). Two places draw it:
 *   - in the chat: a `::ask <id>::` line in one of Robert's rows (src/robert-asks.ts writes it) is
 *     replaced by the live card for that asks row — who asks, the question, the option chips, an
 *     answer box — and collapses to one ✓ line once answered;
 *   - behind the "? N" button: every question waiting on the operator, across the fleet, each
 *     answerable in place. Asks rows (mc ask, mc ask-robert escalated, Robert's own) plus terminals
 *     sitting on a question with no asks row behind it (a TUI menu / y-n / free question, or
 *     `mc state blocked --reason question`).
 * Answers go through the doors that already exist: POST /asks/:id/answer, and a terminal's
 * POST /sessions/:id/input — the same body the ask bar sends.
 *
 * The page owns only where the button and panel sit; ctx = { api, toast, sessions(), askOf(s), who(s) }.
 */
(function (root) {
  var MARK = /^::ask ([0-9a-f-]{8,36})::$/;
  var C = null; // ctx, set by init
  var rows = new Map(); // ask id → last row we read
  var L = { btn: null, panel: null, open: false, items: [], asks: [], done: new Map(), t: 0, gen: 0 };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (!isFinite(s)) return "";
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function opts(row) {
    try { var o = row.options ? JSON.parse(row.options) : []; return Array.isArray(o) ? o : []; } catch (e) { return []; }
  }

  // ── items ──────────────────────────────────────────────────────────────────────────────────────
  function fromAsk(r) {
    return {
      key: "ask:" + r.id, kind: "ask", id: r.id,
      who: r.asked_by || r.ticket_key || "An agent",
      question: r.question,
      // Robert's recommendation rides with an ask he handed up — it is the one line worth reading twice.
      note: r.escalated_at && r.triage ? r.triage : null,
      options: opts(r), text: true,
      at: Date.parse(r.created_at) || 0,
      status: r.status, answer: r.answer, by: r.answered_by,
    };
  }
  function fromSession(s, p, who) {
    var at = s.status && s.status.since ? s.status.since : s.last_out || Date.parse(s.created_at) || 0;
    var base = { key: "term:" + s.id, kind: "term", id: s.id, who: who, at: at, status: "open", note: null };
    if (p && p.kind === "select") {
      return Object.assign(base, { question: p.question || "pick one", options: (p.options || []).map(function (o) { return o.label; }), offsets: (p.options || []).map(function (o) { return o.offset; }), text: false });
    }
    if (p && p.kind === "yn") return Object.assign(base, { question: p.question || "yes or no?", options: ["Yes", "No"], yn: true, text: false });
    return Object.assign(base, { question: (p && p.question) || s.state_label || "asked you", options: [], text: true });
  }
  /**
   * Everything waiting on the operator. `asks` is GET /asks?status=open (live bucket): the rows marked
   * for_operator are his; any terminal with an open ask of ANY route is already represented (or is
   * still with Robert/its Lead), so its screen prompt is not listed a second time. A Lead's worker is
   * its Lead's to answer, not his.
   */
  function collect(asks, sessions, askOf, who) {
    var asking = new Set();
    var out = [];
    (asks || []).forEach(function (r) {
      if (r.status !== "open") return;
      if (r.session_id) asking.add(r.session_id);
      if (r.for_operator) out.push(fromAsk(r));
    });
    var live = new Set((sessions || []).filter(function (s) { return s.live; }).map(function (s) { return s.id; }));
    (sessions || []).forEach(function (s) {
      if (!s.live || asking.has(s.id) || (s.lead_id && live.has(s.lead_id))) return;
      var p = askOf(s);
      if (p) return void out.push(fromSession(s, p, who(s)));
      if (s.state === "blocked" && s.blocked_reason === "question" && s.state_label) out.push(fromSession(s, null, who(s)));
    });
    return out.sort(function (a, b) { return a.at - b.at; });
  }

  // ── the card ───────────────────────────────────────────────────────────────────────────────────
  function html(it) {
    if (it.status === "loading") return '<div class="askc done"><span class="ak-q1">…</span></div>';
    if (it.status === "cancelled") {
      return '<div class="askc done gone" data-akey="' + esc(it.key) + '"><span class="ak-q1">' + esc(it.question) + '</span><span class="ak-a">dropped</span></div>';
    }
    if (it.status === "answered") {
      return '<div class="askc done" data-akey="' + esc(it.key) + '" title="' + esc(it.who + " asked: " + it.question + (it.answer ? "\n→ " + it.answer : "")) + '">' +
        '<span class="ak-ok">✓</span><span class="ak-q1">' + esc(it.question) + '</span>' +
        '<span class="ak-a">' + esc(it.answer || "answered") + (it.by && it.by !== "operator" && it.by !== "human" ? ' <i>· ' + esc(it.by) + '</i>' : "") + '</span></div>';
    }
    var ops = (it.options || []).map(function (o, i) {
      return '<button type="button" data-akopt="' + i + '" title="' + esc(o) + '">' + esc(o) + '</button>';
    }).join("");
    return '<div class="askc" data-akey="' + esc(it.key) + '">' +
      '<div class="ak-h"><span class="ak-i">?</span><span class="ak-who">' + esc(it.who) + '</span><span class="ak-age">' + esc(ago(it.at)) + '</span></div>' +
      '<div class="ak-q">' + esc(it.question) + '</div>' +
      (it.note ? '<div class="ak-note"><b>Robert:</b> ' + esc(it.note) + '</div>' : "") +
      (ops ? '<div class="ak-ops">' + ops + '</div>' : "") +
      (it.text ? '<form class="ak-f"><input name="a" placeholder="' + (ops ? "or say something else…" : "Your answer…") + '" autocomplete="off" enterkeyhint="send"><button>Answer</button></form>' : "") +
      '</div>';
  }
  var byKey = new Map(); // key → item currently drawn somewhere
  function paint(it) {
    byKey.set(it.key, it);
    document.querySelectorAll('.askc-host[data-akey="' + it.key + '"]').forEach(function (h) { h.innerHTML = html(it); });
  }
  function host(it) {
    byKey.set(it.key, it);
    var h = document.createElement("div");
    h.className = "askc-host";
    h.dataset.akey = it.key;
    h.innerHTML = html(it);
    return h;
  }

  // ── answering ──────────────────────────────────────────────────────────────────────────────────
  function termBody(it, i, text) {
    if (i == null) return { text: text, enter: true };
    if (it.yn) return { text: i === 0 ? "y" : "n", enter: true };
    var off = (it.offsets || [])[i] || 0;
    var keys = [];
    for (var k = 0; k < Math.abs(off); k++) keys.push(off > 0 ? "down" : "up");
    keys.push("enter");
    return { keys: keys };
  }
  async function answer(it, i, text) {
    var said = i != null ? it.options[i] : text;
    if (!said) return;
    var card = document.querySelectorAll('.askc-host[data-akey="' + it.key + '"] .askc');
    card.forEach(function (c) { c.classList.add("sending"); });
    try {
      if (it.kind === "ask") {
        var row = await C.api("/asks/" + it.id + "/answer", { method: "POST", body: JSON.stringify({ answer: said, by: "operator" }) });
        rows.set(row.id, row);
        it = fromAsk(row);
      } else {
        await C.api("/sessions/" + it.id + "/input", { method: "POST", body: JSON.stringify(Object.assign(termBody(it, i, text), { by: "operator" })) });
        it = Object.assign({}, it, { status: "answered", answer: said, by: null });
      }
      L.done.set(it.key, it);
      paint(it);
      recount();
    } catch (e) {
      card.forEach(function (c) { c.classList.remove("sending"); });
      var msg = String((e && e.message) || e);
      try { msg = JSON.parse(msg).error || msg; } catch (x) {}
      // Someone got there first (the phone, Robert, `mc answer`): show what they said instead.
      if (it.kind === "ask" && e && e.status === 409) return void refreshAsk(it.id);
      C.toast(msg.slice(0, 140));
    }
  }
  function wire(el) {
    el.addEventListener("click", function (e) {
      var b = e.target.closest("[data-akopt]");
      if (!b) return;
      var h = b.closest(".askc-host"); var it = h && byKey.get(h.dataset.akey);
      if (it && it.status === "open") answer(it, Number(b.dataset.akopt), null);
    });
    el.addEventListener("submit", function (e) {
      var f = e.target.closest(".ak-f");
      if (!f) return;
      e.preventDefault();
      var h = f.closest(".askc-host"); var it = h && byKey.get(h.dataset.akey);
      var v = f.elements.a.value.trim();
      if (it && v && it.status === "open") answer(it, null, v);
    });
    // Typing into a card must not reach the page's own shortcuts (y/n/⏎ answer the staged terminal).
    el.addEventListener("keydown", function (e) { if (e.target.closest && e.target.closest(".ak-f")) e.stopPropagation(); });
  }

  // ── in the chat: `::ask <id>::` → the live card ────────────────────────────────────────────────
  async function refreshAsk(id) {
    try {
      var r = await C.api("/asks/" + id);
      rows.set(r.id, r);
      paint(fromAsk(r));
    } catch (e) {
      // Gone, or another workspace's: a card that can never load is not left spinning.
      if (e && e.status === 404) document.querySelectorAll('.askc-host[data-akey="ask:' + id + '"]').forEach(function (h) { h.remove(); });
    }
  }
  function embed(bub) {
    if (!C || !bub) return;
    var hit = false, other = false;
    Array.prototype.slice.call(bub.querySelectorAll("p")).forEach(function (p) {
      var m = MARK.exec((p.textContent || "").trim());
      if (!m) { if ((p.textContent || "").trim()) other = true; return; }
      hit = true;
      var id = m[1];
      var r = rows.get(id);
      var it = r ? fromAsk(r) : { key: "ask:" + id, kind: "ask", id: id, who: "…", question: "", options: [], status: "loading" };
      var h = host(it);
      p.replaceWith(h);
      if (!r || r.status === "open") refreshAsk(id);
    });
    // A row that is only the card drops the bubble around it: the card is the message.
    if (hit && !other) bub.classList.add("ak-only");
  }

  // ── the "? N" list ─────────────────────────────────────────────────────────────────────────────
  function recount() {
    if (!C) return;
    L.items = collect(L.asks, C.sessions(), C.askOf, C.who);
    var n = L.items.length;
    if (L.btn) {
      L.btn.hidden = !n && !L.open;
      L.btn.textContent = "? " + n;
      L.btn.classList.toggle("on", L.open);
      L.btn.title = n ? n + " question" + (n > 1 ? "s" : "") + " waiting on you" : "nothing waiting on you";
    }
    if (L.open) drawList();
  }
  function drawList() {
    var p = L.panel;
    var keep = new Set();
    var list = L.items.concat(Array.from(L.done.values()).filter(function (d) { return !L.items.some(function (x) { return x.key === d.key; }); }));
    if (!list.length) { p.innerHTML = '<div class="ak-empty">Nothing waiting on you.</div>'; return; }
    // Redraw only what changed, so a card you are typing into keeps its text and focus.
    var empty = p.querySelector(".ak-empty"); if (empty) empty.remove();
    list.forEach(function (it, i) {
      keep.add(it.key);
      var h = p.querySelector('.askc-host[data-akey="' + it.key + '"]');
      var prev = byKey.get(it.key);
      if (!h) h = host(it);
      else if (!prev || prev.status !== it.status || prev.question !== it.question || prev.note !== it.note || (prev.options || []).join() !== (it.options || []).join()) { byKey.set(it.key, it); h.innerHTML = html(it); }
      else { byKey.set(it.key, it); var age = h.querySelector(".ak-age"); if (age) age.textContent = ago(it.at); }
      if (p.children[i] !== h) p.insertBefore(h, p.children[i] || null);
    });
    Array.prototype.slice.call(p.children).forEach(function (c) { if (!keep.has(c.dataset.akey)) c.remove(); });
  }
  async function load() {
    var gen = ++L.gen;
    try {
      var a = await C.api("/asks?status=open");
      if (gen !== L.gen) return;
      L.asks = Array.isArray(a) ? a : [];
    } catch (e) {}
    recount();
  }
  function loadSoon() { clearTimeout(L.t); L.t = setTimeout(load, 250); }
  function toggle(open) {
    L.open = open == null ? !L.open : !!open;
    L.panel.hidden = !L.open;
    if (L.open) { L.done.clear(); L.panel.innerHTML = ""; drawList(); var f = L.panel.querySelector(".ak-f input"); if (f && matchMedia("(pointer:fine)").matches) f.focus(); }
    else L.done.clear();
    recount();
  }

  /** Bus events the widget wants: what changes a card or the count. The page forwards them all. */
  var TOPICS = ["ask.created", "ask.answered"];
  function onEvent(e) {
    if (!C || !e) return;
    if (e.topic === "ask.answered" && e.ask_id) { if (document.querySelector('.askc-host[data-akey="ask:' + e.ask_id + '"]')) refreshAsk(e.ask_id); return loadSoon(); }
    if (e.topic === "ask.created") return loadSoon();
    // An escalation files no event of its own; its card arrives as one of Robert's rows.
    if (e.topic === "agent.push" && /::ask [0-9a-f-]{8,36}::/.test(e.reply || "")) return loadSoon();
    if (e.topic === "session.ended" || e.topic === "session.started") return loadSoon();
    // A terminal's own question comes and goes with its screen: recount once the page has applied it.
    if (e.topic === "session.status" || e.topic === "session.activity" || e.topic === "agent.state") recountSoon();
  }
  var rcT = 0;
  function recountSoon() { clearTimeout(rcT); rcT = setTimeout(recount, 200); }

  function init(ctx) {
    C = ctx;
    if (ctx.button && ctx.panel) {
      L.btn = ctx.button; L.panel = ctx.panel;
      L.btn.addEventListener("click", function () { toggle(); });
      wire(L.panel);
      L.panel.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); toggle(false); } });
    }
    if (ctx.log) wire(ctx.log);
    load();
    // Ages tick, and a missed event (a sleep, a dropped socket) heals within a minute.
    setInterval(function () { if (document.visibilityState !== "hidden") load(); }, 60000);
  }

  root.AskCard = { MARK: MARK, TOPICS: TOPICS, init: init, embed: embed, onEvent: onEvent, recount: recount, toggle: toggle, collect: collect, html: html, fromAsk: fromAsk, termBody: termBody };
})(typeof window !== "undefined" ? window : globalThis);

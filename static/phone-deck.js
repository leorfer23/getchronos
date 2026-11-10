/* The phone's approval deck — the things waiting for the operator's decision, one card at a time,
 * verdict first, with the evidence that makes a yes a confident yes. Swipe between cards; each one
 * ends in Yes · Later · Change (or the question's own answers).
 *
 * ── One adapter ─────────────────────────────────────────────────────────────────────────────────
 * loadQueue() turns whatever the daemon has into normalized items, and decide() carries a decision
 * back. Everything else (cards, voice) reads only the normalized item. TODAY the adapter reads:
 *   · hand-offs (`mc outcome`): /desk rows (`handoff`, `outcome_at`) → GET /sessions/:id/decisions for
 *     the body, GET /sessions/:id/artifacts for the PR's title/state/checks (gh, cached daemon-side);
 *   · questions: GET /asks?status=open (rows marked for_operator) + terminals sitting on a question on
 *     screen — the same list the Ask widget builds (AskCard.collect);
 *   · terminals that stopped and need him (phase "blocked") with no question behind them;
 *   · drafts an agent left: GET /drafts (the daemon's in-memory list of announced drafts — a stopgap
 *     until the request ledger records deliverables).
 * PREFERRED when the daemon has it — the request ledger (LEDGER.md): GET /api/ledger/queue gives the
 * items in the order he should hear them, GET /api/ledger/:id the hand-off behind one, and
 * POST /api/ledger/:id/decision records his answer (executes nothing). A daemon without those routes
 * (404) gets the sources above. The choice is made inside loadQueue()/decide() and nowhere else.
 *
 * What is real today and what waits (also in the report):
 *   real   — his words (spawn goal), the agent's summary/changes/proof/screenshots, PR links, the PR's
 *            title/state/CI (gh), the terminal's own +/− line counts, open questions and their options,
 *            blocked reasons, a draft's recipient/channel/full text (when the hook carried it);
 *   agent's word only — every "check": today's proof is self-reported, so the card says so and never
 *            calls it verified; the finish-line ticks are the agent's own `mc goal check`;
 *   waits  — independent checks (verifier), PR file counts, a server-side record of Later/Got it
 *            (kept on this phone until the ledger), sending a draft or merging by itself (executor).
 *
 * What "Yes" does today never exceeds what the system already allows:
 *   merge / deploy hand-off → the Desk's own approval line typed into that terminal (OK_LINE below);
 *   a question            → the existing answer door (POST /asks/:id/answer, or the terminal's input);
 *   a draft               → nothing is sent (there is no executor, agents never send): his approval is
 *                           typed into the terminal that wrote it, as a record; he sends it himself;
 *   a read (review)       → marked read on this phone.
 *
 * ctx = { api, token(), toast(msg, act), fx, sessions(), visible(s), wsColor(id), wsName(id),
 *         input(id, body) → Promise, openTerminal(id), lang(), voice, md(text) → safe html,
 *         compose({title, placeholder}) → Promise<string|null>, onChange(items), onOpen(open) }
 */
(function (root) {
  var C = null;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var norm = function (t) { return " " + String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " "; };
  var t = function (es, en) { return C && C.lang() === "es" ? es : en; };

  // The Desk's approval lines (static/desk.html OK_LINE): typed, not executed by the page — the agent
  // knows its repo's own way to merge and deploy, and the line is in its transcript as his decision.
  var OK_LINE = {
    merge: "Approved: merge the PR once its checks are green. Don't deploy. Then run `mc outcome --shipped \"merged #<n>\"`.",
    "merge+deploy": "Approved: merge the PR once its checks are green, then deploy it. Then run `mc outcome --shipped \"merged #<n>\" --shipped \"deployed\"`.",
    deploy: "Approved: deploy it. Then run `mc outcome --shipped \"deployed\"`.",
  };
  var KIND_WORD = { merge: "Merge", deploy: "Deploy", "merge+deploy": "Merge + deploy", review: "Read", question: "Question", blocked: "Stopped", draft: "Draft" };
  var RANK = { blocked: 0, question: 1, merge: 2, "merge+deploy": 2, deploy: 2, draft: 3, review: 4 };
  var YES_WORD = { merge: "Merge", deploy: "Deploy", "merge+deploy": "Merge + deploy", review: "Got it", draft: "Approve" };

  // ── local decisions (until the ledger records them) ───────────────────────────────────────────
  var DKEY = "phone-decided";
  function decided() { try { return JSON.parse(localStorage.getItem(DKEY) || "{}") || {}; } catch (e) { return {}; } }
  function record(key, d, until) {
    var all = decided(), now = Date.now();
    for (var k in all) if (now - (all[k].at || 0) > 4 * 86400000) delete all[k];
    all[key] = { d: d, at: now, until: until || null };
    try { localStorage.setItem(DKEY, JSON.stringify(all)); } catch (e) {}
  }
  function unrecord(key) { var all = decided(); delete all[key]; try { localStorage.setItem(DKEY, JSON.stringify(all)); } catch (e) {} }
  function hidden(key) {
    var r = decided()[key];
    if (!r) return false;
    if (r.d === "later") return Date.now() < (r.until || 0);
    return true;
  }

  // ── evidence: the agent's proof lines, grouped into checks with a plain pass/fail ────────────────
  // In this order: a line about the whole suite or what did NOT change is "nothing else broke", even
  // though it says "suite"; only then is a line about tests "tests".
  var GROUPS = [
    { id: "intact", name: "Nothing else broke", re: /\b(full suite|whole suite|nothing else|no other|regress\w*|typecheck\w*|tsc|lint\w*|builds?|smoke|re-?ran|re-?run|callers?|still pass\w*|unchanged)\b/i },
    { id: "tests", name: "Tests", re: /\b(tests?|specs?|suite|jest|vitest|pytest|mocha|npm (run )?test|unit|e2e|playwright|passed|passing)\b/i },
    { id: "review", name: "Review", re: /\b(review\w*|second model|read the diff|diff read)\b/i },
    { id: "checked", name: "Checked by hand", re: /\b(checked|verified|confirmed|cross-?checked|compared|screens?hots?|widths?|viewport|tried|reproduc\w*|query|queries|totals?)\b/i },
  ];
  // A line fails when it says something failed — but "0 failed", "no failures", "nothing broke" pass.
  var FAILWORD = /\b(fail(?:ed|s|ing|ures?)?|broken|broke|errors?|crash(?:ed|es)?|red)\b|✕|✗/gi;
  function lineFails(line) {
    var m, s = String(line || "");
    FAILWORD.lastIndex = 0;
    while ((m = FAILWORD.exec(s))) {
      var before = s.slice(Math.max(0, m.index - 12), m.index).toLowerCase();
      if (/\b(0|no|zero|without|none|nothing|never|not)\s*(new\s+)?$/.test(before)) continue;
      return true;
    }
    return false;
  }
  function groupProof(proof) {
    var out = [], used = new Set();
    GROUPS.forEach(function (g) {
      var lines = (proof || []).filter(function (l, i) { if (used.has(i) || !g.re.test(l)) return false; used.add(i); return true; });
      if (lines.length) out.push({ id: g.id, name: g.name, lines: lines, state: lines.some(lineFails) ? "fail" : "pass" });
    });
    var rest = (proof || []).filter(function (l, i) { return !used.has(i); });
    if (rest.length) out.push({ id: "other", name: "Evidence", lines: rest, state: rest.some(lineFails) ? "fail" : "pass" });
    return out;
  }
  // Screenshots: "before"/"after" (any order, any prefix/suffix: "desktop-before", "after 390") pair up.
  function pairShots(shots) {
    var pairs = [], singles = [], by = new Map();
    (shots || []).forEach(function (s) {
      var l = String(s.label || "").toLowerCase();
      var side = /\bbefore\b|\bantes\b/.test(l) ? "before" : /\bafter\b|\bdespu[eé]s\b/.test(l) ? "after" : null;
      if (!side) { singles.push(s); return; }
      var k = l.replace(/\bbefore\b|\bafter\b|\bantes\b|\bdespu[eé]s\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
      var p = by.get(k) || { label: k, before: null, after: null };
      if (p[side]) { singles.push(s); return; }
      p[side] = s; by.set(k, p);
    });
    by.forEach(function (p) { if (p.before && p.after) pairs.push(p); else singles.push(p.before || p.after); });
    return { pairs: pairs, singles: singles };
  }
  var firstSentence = function (s) {
    var x = String(s || "").replace(/\s+/g, " ").replace(/[*_`#>]/g, "").trim();
    var m = /^(.{12,240}?[.!?])(\s|$)/.exec(x);
    return m ? m[1] : x.length > 240 ? x.slice(0, 239) + "…" : x;
  };
  var plain = function (s) { return String(s || "").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim(); };
  var cap = function (s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); };
  var prOf = function (url) { var m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url || ""); return m ? { url: url, repo: m[1], num: Number(m[2]), title: null, state: null, ci: null } : null; };
  var hash = function (s) { var h = 0, x = String(s); for (var i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  /**
   * The ledger's draft target (src/ledger-model.ts draftHash, computed by `mc hook` where the text is):
   * "sha256:" + sha256 of JSON [channel, to, subject, text] — channel and recipient trimmed and lower-
   * cased, subject trimmed ("" for Slack), text verbatim. Computed here from the text the card shows,
   * so a yes is only bound to a draft whose words are exactly the words he read or heard.
   */
  function draftCanon(d) {
    var to = d.kind === "email" ? d.to : d.channel || d.to;
    return JSON.stringify([d.kind === "email" ? "email" : "slack", String(to || "").trim().toLowerCase(), d.kind === "email" ? String(d.subject || "").trim() : "", d.text == null ? "" : String(d.text)]);
  }
  async function draftHash(d) {
    if (!root.crypto || !root.crypto.subtle || !root.TextEncoder) return null;
    var buf = await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(draftCanon(d)));
    return "sha256:" + Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  // ── the adapter ────────────────────────────────────────────────────────────────────────────────
  var DEC = new Map(); // session id → { at: outcome_at, data: /decisions }
  var ARTS = new Map(); // session id → { t, prs }
  var Q = { items: [], loaded: false, gen: 0, err: null };

  async function decisionsFor(s) {
    var c = DEC.get(s.id);
    if (c && c.at === (s.outcome_at || "")) return c.data;
    var d = await C.api("/sessions/" + s.id + "/decisions");
    DEC.set(s.id, { at: s.outcome_at || "", data: d });
    return d;
  }

  function handoffItem(s, o) {
    if (!o || (o.shipped && o.shipped.length)) return null;
    var kind = o.ask === "merge" || o.ask === "deploy" || o.ask === "merge+deploy" ? o.ask : o.ask === "review" ? "review" : null;
    if (!kind) return null;
    var sh = pairShots(o.shots);
    var u = s.usage || {};
    var added = s.lines_added || u.lines_added || 0, removed = s.lines_removed || u.lines_removed || 0;
    var checks = (s.done_when || []).map(function (text, i) { return { text: text, met: !!(s.done_checked || [])[i] }; });
    var it = {
      key: "handoff:" + s.id + ":" + (o.at || ""), kind: kind, ws: s.workspace_id, sid: s.id, live: !!s.live,
      at: Date.parse(o.at) || Date.now(), title: plain(s.goal || s.title || ""),
      asked: plain(s.spawn_goal || s.first_prompt || s.goal || ""),
      verdict: cap(firstSentence(o.summary)), summary: o.summary || "", changes: o.changes || [], proof: o.proof || [],
      checks: groupProof(o.proof), finish: checks.length ? { total: checks.length, met: checks.filter(function (c) { return c.met; }).length, items: checks } : null,
      shots: o.shots || [], pairs: sh.pairs, singles: sh.singles,
      prs: (o.prs || []).map(prOf).filter(Boolean),
      size: added || removed ? { added: added, removed: removed } : null,
    };
    it.rev = hash([it.key, it.verdict, it.proof.join("|"), it.prs.map(function (p) { return p.url; }).join("|")].join("§"));
    return it;
  }
  function questionItem(q) {
    var s = q.kind === "term" ? (C.sessions().find(function (x) { return x.id === q.id; }) || null) : null;
    var ws = q.kind === "ask" ? q.ws : s && s.workspace_id;
    var key = q.kind === "ask" ? "ask:" + q.id : "prompt:" + q.id + ":" + hash(q.question + (q.options || []).join("|"));
    var it = {
      key: key, kind: "question", ws: ws || null, sid: q.kind === "term" ? q.id : q.sid || null, askId: q.kind === "ask" ? q.id : null, live: true,
      at: q.at || Date.now(), title: plain(q.who || ""), asked: null,
      verdict: cap(plain(q.question)), question: { text: q.question, options: q.options || [], yn: !!q.yn, free: !!q.text, note: q.note || null, src: q },
    };
    it.rev = hash(key + "§" + it.verdict + "§" + it.question.options.join("|"));
    return it;
  }
  function blockedItem(s) {
    var why = (s.status && s.status.line) || s.state_label || String(s.blocked_reason || "").replace(/_/g, " ") || "it stopped and needs you";
    var since = (s.status && s.status.since) || s.last_out || Date.parse(s.created_at) || Date.now();
    var it = {
      key: "blocked:" + s.id + ":" + since, kind: "blocked", ws: s.workspace_id, sid: s.id, live: true, at: since,
      title: plain(s.goal || s.title || ""), asked: plain(s.spawn_goal || s.goal || ""), verdict: cap(plain(why)),
    };
    it.rev = hash(it.key + "§" + it.verdict);
    return it;
  }
  function draftItem(d) {
    var to = d.to || d.channel || "";
    var s = d.session_id ? C.sessions().find(function (x) { return x.id === d.session_id; }) || null : null;
    var it = {
      key: "draft:" + d.id, kind: "draft", ws: d.workspace_id || null, sid: d.session_id || null, draftId: d.id,
      live: !!(s && s.live),
      at: Date.parse(d.at) || Date.now(), title: plain(d.where || ""), asked: s ? plain(s.spawn_goal || s.goal || "") || null : null,
      verdict: (d.kind === "email" ? "Email" : "Slack message") + (to ? " to " + to : "") + " — ready for your yes",
      draft: { kind: d.kind === "email" ? "email" : "slack", to: d.to || null, channel: d.channel || null, subject: d.subject || null, text: d.text || null, label: d.label || "" },
    };
    it.rev = hash(it.key + "§" + (d.text || d.label || ""));
    return it;
  }

  // ── the ledger (preferred) ──────────────────────────────────────────────────────────────────
  var LED = new Map(); // request id → { at, data: GET /ledger/:id }
  var LEDGER_ACTION = { merge: "merge", deploy: "deploy", send: "draft", review: "review", answer: "question" };
  async function ledgerDetail(q) {
    var c = LED.get(q.request_id);
    if (c && c.at === q.created_at && Date.now() - c.t < 60000) return c.data;
    var d = await C.api("/ledger/" + q.request_id);
    LED.set(q.request_id, { at: q.created_at, t: Date.now(), data: d });
    return d;
  }
  /** One ledger queue item → a card. The hand-off behind it comes from the request's detail. */
  async function ledgerItem(q, ctx) {
    var kind = LEDGER_ACTION[q.action];
    if (!kind) return null;
    var led = { item: q.item_id, request: q.request_id, target_hash: q.target_hash || null, bound: !!q.bound, action: q.action, work: q.kind || null, checks: q.checks || null };
    var base = { ws: (q.workspace && q.workspace.id) || null, asked: plain(q.words || ""), at: Date.parse(q.created_at) || Date.now() };
    if (kind === "question") {
      var row = q.ask_id ? ctx.askRow.get(q.ask_id) : null;
      var qi = row ? ctx.qByAsk.get(row.id) : null;
      var it = qi ? questionItem(qi) : questionItem({ kind: "ask", id: q.ask_id || q.item_id, who: q.title, question: q.label, options: [], text: true, at: base.at, ws: base.ws });
      it.src = "ledger"; it.ledger = led; it.asked = base.asked || null;
      return it;
    }
    if (kind === "draft") {
      var dv = q.deliverable || {};
      var match = ctx.drafts.find(function (d) { return d.hash && d.hash === q.target_hash; }) || null;
      var di = draftItem(match || { id: q.item_id, kind: dv.kind === "email_draft" ? "email" : "slack", label: q.label || dv.label || "", where: q.title, at: q.created_at, workspace_id: base.ws });
      if (match) ctx.used.add(match.id);
      di.key = "ledger:" + q.item_id; di.src = "ledger"; di.ledger = led; di.asked = base.asked || null;
      di.hashOk = !!(match && match.hash && match.hash === q.target_hash);
      return di;
    }
    var det = await ledgerDetail(q).catch(function () { return null; });
    if (!det) return null;
    var res = (det.result || []).slice(-1)[0] || null;
    var term = (det.terminals || []).find(function (t) { return t.primary && t.live; }) || (det.terminals || []).find(function (t) { return t.primary; }) || null;
    var sid = (res && res.session_id) || (term && term.session_id) || null;
    var sess = (sid && C.sessions().find(function (x) { return x.id === sid; })) || { id: sid, live: !!(term && term.live), done_when: term ? term.done_when : [], done_checked: term ? term.done_checked : [] };
    var h = res ? handoffItem(sess, Object.assign({}, res.outcome, { ask: kind === "review" ? "review" : q.action, shipped: [] })) : null;
    if (!h) return null;
    h.key = "ledger:" + q.item_id; h.src = "ledger"; h.ledger = led; h.asked = base.asked || h.asked; h.ws = base.ws || h.ws;
    h.verified = (det.checks || []).map(function (c) { return { name: c.name, state: c.status === "pass" ? "pass" : c.status === "fail" ? "fail" : "none", lines: (c.evidence || []).map(function (e) { return typeof e === "string" ? e : (e && (e.label || e.ref)) || ""; }).filter(Boolean) }; });
    if (led.work === "ui" && !h.pairs.length) h.warn = "A UI change with no before/after screenshots.";
    if (OK_LINE[h.kind] && !led.bound) h.note = "Not bound to an exact version yet — your yes goes to the terminal, as on the Desk.";
    return h;
  }

  /** The sources → normalized items, ordered for the next decision. Ledger first; today's endpoints when it is absent. */
  async function loadQueue() {
    var led = await C.api("/ledger/queue").catch(function () { return null; });
    var sessions = C.sessions().filter(function (s) { return C.visible(s); });
    var items = [];
    if (led && Array.isArray(led.items)) {
      Q.source = "ledger";
      var asks0 = await C.api("/asks?status=open").catch(function () { return []; });
      var qs0 = root.AskCard ? root.AskCard.collect(asks0, sessions, C.askOf, function (s) { return plain(s.goal || s.title || "terminal"); }) : [];
      var ctx = { askRow: new Map((asks0 || []).map(function (a) { return [a.id, a]; })), qByAsk: new Map(qs0.filter(function (q) { return q.kind === "ask"; }).map(function (q) { return [q.id, q]; })), drafts: await draftsWithHash(), used: new Set() };
      var got = await Promise.all(led.items.map(function (q) { return ledgerItem(q, ctx).catch(function () { return null; }); }));
      got.forEach(function (it) { if (it) items.push(it); });
      // What the ledger does not hold as an item but still needs him: a terminal sitting on a question
      // on its screen, a terminal that stopped, a draft the ledger missed.
      var asking = new Set();
      qs0.forEach(function (q) { if (q.kind === "term") { asking.add(q.id); items.push(questionItem(q)); } else { var r = ctx.askRow.get(q.id); if (r && r.session_id) asking.add(r.session_id); } });
      sessions.forEach(function (s) { var ph = s.status && s.status.phase ? s.status.phase : s.state; if (s.live && ph === "blocked" && !asking.has(s.id)) items.push(blockedItem(s)); });
      ctx.drafts.forEach(function (d) { if (!ctx.used.has(d.id)) items.push(draftItem(d)); });
      var seenKey = new Set();
      items = items.filter(function (it) { if (seenKey.has(it.key) || hidden(it.key)) return false; seenKey.add(it.key); return true; });
      items.sort(function (a, b) { return (RANK[a.kind] - RANK[b.kind]) || (a.at - b.at); });
      return items;
    }
    Q.source = "today";
    // 1. Hand-offs: a merge/deploy ask rides on the /desk row; a request for a read only shows as
    //    outcome_at, so its body is read once per new hand-off (cached by outcome_at).
    var withOutcome = sessions.filter(function (s) { return s.live && (s.handoff || s.outcome_at); });
    var bodies = await Promise.all(withOutcome.map(function (s) { return decisionsFor(s).catch(function () { return null; }); }));
    withOutcome.forEach(function (s, i) { var it = bodies[i] && handoffItem(s, bodies[i].outcome); if (it) items.push(it); });
    // 2. Questions (asks for him + terminals sitting on a question) — the Ask widget's own list.
    var asks = await C.api("/asks?status=open").catch(function () { return []; });
    var asking = new Set();
    var qs = root.AskCard ? root.AskCard.collect(asks, sessions, C.askOf, function (s) { return plain(s.goal || s.title || "terminal"); }) : [];
    var askRow = new Map((asks || []).map(function (a) { return [a.id, a]; }));
    qs.forEach(function (q) {
      var row = q.kind === "ask" ? askRow.get(q.id) : null;
      if (row) { q.ws = row.workspace_id; q.sid = row.session_id; }
      if (q.kind === "term") asking.add(q.id); else if (row && row.session_id) asking.add(row.session_id);
      items.push(questionItem(q));
    });
    // 3. Stopped, with no question behind it.
    sessions.forEach(function (s) {
      var ph = s.status && s.status.phase ? s.status.phase : s.state;
      if (s.live && ph === "blocked" && !asking.has(s.id)) items.push(blockedItem(s));
    });
    // 4. Drafts (stopgap list on the daemon; an older daemon has none).
    (await draftsWithHash()).forEach(function (d) { items.push(draftItem(d)); });
    items = items.filter(function (it) { return !hidden(it.key); });
    items.sort(function (a, b) { return (RANK[a.kind] - RANK[b.kind]) || (a.at - b.at); });
    return items;
  }

  async function draftsWithHash() {
    var r = await C.api("/drafts").catch(function () { return null; });
    var list = (r && r.drafts) || [];
    await Promise.all(list.map(function (d) { return d.text ? draftHash(d).then(function (h) { d.hash = h; }).catch(function () {}) : null; }));
    return list;
  }

  /**
   * Carry one decision back — TODAY through the doors that already exist (see the header). Returns
   * what to tell him. `words` is his own text for change / a free answer; `opt` an option index.
   */
  async function decide(it, d, words, opt, meta) {
    var sid = it.sid;
    var typeInto = function (text) {
      if (!sid || !it.live) throw new Error(t("Esa terminal ya terminó", "That terminal has ended"));
      return C.input(sid, { text: text, enter: true });
    };
    if (it.src === "ledger" && it.ledger) return decideLedger(it, d, words, opt, meta || {}, typeInto);
    if (d === "later") {
      if (it.kind === "question" && it.askId) {
        // A real "later" exists for questions: date it off the live list (holds.ts).
        await C.api("/asks/" + it.askId + "/hold", { method: "POST", body: JSON.stringify({ until: "+2h", reason: "later, from the phone" }) });
      }
      record(it.key, "later", Date.now() + 2 * 3600000);
      return t("Te lo dejo para después.", "Later, then.");
    }
    if (it.kind === "question") {
      var q = it.question, said = opt != null ? q.options[opt] : words;
      if (!said) throw new Error("no answer");
      if (it.askId) {
        await C.api("/asks/" + it.askId + "/answer", { method: "POST", body: JSON.stringify({ answer: said, by: "operator" }) });
      } else {
        var body = root.AskCard ? root.AskCard.termBody(q.src, opt == null ? null : opt, words) : { text: said, enter: true };
        await C.input(sid, body);
      }
      record(it.key, "yes");
      return t("Le respondí: ", "Answered: ") + said + ".";
    }
    if (it.kind === "blocked") {
      if (d !== "change" || !words) throw new Error("say what to tell it");
      await typeInto(words);
      record(it.key, "change");
      return t("Se lo dije.", "Told it.");
    }
    if (d === "change") {
      if (!words) throw new Error("say what should change");
      if (it.kind === "draft") await typeInto("Change the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + ": " + words);
      else await typeInto("Changes needed: " + words);
      record(it.key, "change");
      return t("Le pedí: ", "Asked for: ") + words;
    }
    // d === "yes"
    if (OK_LINE[it.kind]) {
      await typeInto(OK_LINE[it.kind]);
      record(it.key, "yes");
      return { merge: t("Listo. Le dije que mergee.", "Done — told it to merge."), deploy: t("Listo. Le dije que despliegue.", "Done — told it to deploy."), "merge+deploy": t("Listo. Le dije que mergee y despliegue.", "Done — told it to merge and deploy.") }[it.kind];
    }
    if (it.kind === "draft") {
      // Nothing is sent: there is no executor and agents never send. The yes is recorded where one can
      // be today — the terminal that wrote it — and here.
      if (sid && it.live) await typeInto("Approved: the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + " is good as written. Leave it as a draft — I'll send it myself.").catch(function () {});
      record(it.key, "yes");
      return t("Aprobado. Sigue como borrador: lo mandás vos desde " + (it.draft.kind === "email" ? "Gmail." : "Slack."), "Approved. It stays a draft — you send it from " + (it.draft.kind === "email" ? "Gmail." : "Slack."));
    }
    if (it.kind === "review") { record(it.key, "read"); return t("Marcado como leído.", "Marked read."); }
    throw new Error("nothing to approve");
  }

  /**
   * A decision on a ledger item: recorded there (POST /api/ledger/:id/decision — his hand only, it
   * executes nothing). What still has to happen today happens through today's doors: a change reaches
   * the terminal as words, and a merge/deploy whose target the verifier has not bound yet (the ledger
   * refuses that yes) is delivered to the terminal as the Desk does. A 409 means the target moved since
   * the card was drawn: nothing is resent — the card is read again and he decides again.
   */
  async function decideLedger(it, d, words, opt, meta, typeInto) {
    var L = it.ledger;
    var post = function (decision, extra) {
      return C.api("/ledger/" + L.request + "/decision", {
        method: "POST", headers: { "x-mc-operator": "1" },
        body: JSON.stringify(Object.assign({ item: L.item, decision: decision, by: meta.voice ? "phone-voice" : "phone" }, extra || {})),
      }).catch(function (e) {
        if (e && e.status === 409) { var x = new Error(t("Cambió desde que lo viste — miralo de nuevo.", "It changed since you saw it — have another look.")); x.moved = true; throw x; }
        throw e;
      });
    };
    if (it.kind === "question") {
      // Answered on the ask; the ledger follows it (LEDGER.md) — one decision, written once.
      var q = it.question, said = opt != null ? q.options[opt] : words;
      if (d === "later") { await post("later", { until: "+2h" }); return t("Te lo dejo para después.", "Later, then."); }
      if (!said) throw new Error("no answer");
      if (it.askId) await C.api("/asks/" + it.askId + "/answer", { method: "POST", body: JSON.stringify({ answer: said, by: "operator" }) });
      else await post("change", { words: said });
      return t("Le respondí: ", "Answered: ") + said + ".";
    }
    if (d === "later") { await post("later", { until: "+2h" }); return t("Te lo dejo para después.", "Later, then."); }
    if (d === "change") {
      if (!words) throw new Error("say what should change");
      await post("change", { words: words });
      if (sid(it)) await typeInto(it.kind === "draft" ? "Change the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + ": " + words : "Changes needed: " + words).catch(function () {});
      return t("Le pedí: ", "Asked for: ") + words;
    }
    // yes
    if (OK_LINE[it.kind]) {
      if (!L.bound) {
        // The ledger cannot take this yes yet (no bound PR head): today's way, said on the card — and kept
        // on this phone so the card does not come back while the ledger waits for the PR to settle.
        await typeInto(OK_LINE[it.kind]);
        record(it.key, "yes");
        return { merge: t("Listo. Le dije que mergee.", "Done — told it to merge."), deploy: t("Listo. Le dije que despliegue.", "Done — told it to deploy."), "merge+deploy": t("Listo. Le dije que mergee y despliegue.", "Done — told it to merge and deploy.") }[it.kind];
      }
      await post("yes", { target_hash: L.target_hash, words: meta.words || null });
      return t("Aprobado y anotado.", "Approved and recorded.");
    }
    if (it.kind === "draft") {
      if (!it.draft.text || !it.hashOk) throw new Error(t("No tengo el texto exacto de ese borrador; no puedo darte el sí.", "I don't have that draft's exact text, so I can't take a yes."));
      await post("yes", { target_hash: L.target_hash, words: meta.words || null });
      return t("Aprobado y anotado. No se mandó nada: sigue en tus borradores.", "Approved and recorded. Nothing was sent — it stays in your drafts.");
    }
    await post("yes", { words: meta.words || null });
    return it.kind === "review" ? t("Marcado como leído.", "Marked read.") : t("Listo.", "Done.");
  }
  function sid(it) { return !!(it.sid && it.live); }

  // ── rendering ──────────────────────────────────────────────────────────────────────────────────
  var D = { el: null, track: null, bar: null, open: false, idx: 0, keys: [], pending: new Set(), shots: new Map(), busy: false };
  var ICON = {
    x: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    ext: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 7-5 5 5 5M15 7l5 5-5 5"/></svg>',
  };
  var ago = function (ms) { var m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "now" : m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; };

  function checksHtml(it) {
    var rows = [];
    (it.checks || []).forEach(function (g, i) {
      rows.push('<button type="button" class="ck ' + g.state + '" data-ck="' + i + '"><i>' + (g.state === "fail" ? "✕" : "✓") + '</i><b>' + esc(g.name) + '</b><span>' + esc(g.lines[0]) + (g.lines.length > 1 ? " · +" + (g.lines.length - 1) : "") + '</span></button>' +
        '<div class="ck-raw" data-ckraw="' + i + '" hidden>' + g.lines.map(function (l) { return "<div>" + esc(l) + "</div>"; }).join("") + "</div>");
    });
    if (it.finish) {
      var all = it.finish.met === it.finish.total;
      rows.push('<button type="button" class="ck ' + (all ? "pass" : "part") + '" data-ck="fin"><i>' + (all ? "✓" : "◐") + '</i><b>Finish line</b><span>' + it.finish.met + " of " + it.finish.total + ' ticked</span></button>' +
        '<div class="ck-raw" data-ckraw="fin" hidden>' + it.finish.items.map(function (c) { return "<div>" + (c.met ? "✓ " : "○ ") + esc(c.text) + "</div>"; }).join("") + "</div>");
    }
    var ci = (it.prs || []).map(function (p) { return p.ci; }).filter(Boolean);
    var verified = (it.verified || []).map(function (g) { return '<div class="ck real ' + g.state + '"><i>' + (g.state === "fail" ? "✕" : g.state === "pass" ? "✓" : "—") + '</i><b>' + esc(g.name) + '</b><span>' + esc(g.lines[0] || "") + "</span></div>"; }).join("");
    var real = ci.length ? '<div class="ck real ' + (ci.indexOf("failing") >= 0 ? "fail" : ci.indexOf("pending") >= 0 ? "part" : "pass") + '"><i>' + (ci.indexOf("failing") >= 0 ? "✕" : ci.indexOf("pending") >= 0 ? "…" : "✓") + '</i><b>GitHub checks</b><span>' + esc(ci.indexOf("failing") >= 0 ? "failing" : ci.indexOf("pending") >= 0 ? "running" : "passing") + "</span></div>" : "";
    var warn = it.warn ? '<div class="ck fail"><i>!</i><b>' + esc(it.warn) + "</b><span></span></div>" : "";
    var ver = verified ? '<div class="qc-h">Verified</div>' + verified : "";
    if (!rows.length && !real && !verified) return '<section class="qc-sec"><div class="qc-h">Checks</div>' + warn + '<div class="ck none"><i>—</i><b>No proof reported</b><span>the agent filed no evidence</span></div></section>';
    return '<section class="qc-sec">' + ver + warn + (rows.length || real ? '<div class="qc-h">Checks <em>the agent’s own word</em></div>' + rows.join("") + real : "") + "</section>";
  }
  function shotsHtml(it) {
    if (!it.pairs.length && !it.singles.length) return "";
    var out = '<section class="qc-sec qc-shots">';
    it.pairs.forEach(function (p, i) {
      out += '<div class="ba" data-pair="' + i + '" style="--x:50%">' +
        '<img class="ba-b" data-shot="' + esc(p.before.name) + '" alt="before">' +
        '<div class="ba-a"><img data-shot="' + esc(p.after.name) + '" alt="after"></div>' +
        '<div class="ba-div"><span>' + ICON.grip + "</span></div>" +
        '<span class="ba-tag l">Before</span><span class="ba-tag r">After</span>' +
        (p.label ? '<span class="ba-cap">' + esc(p.label) + "</span>" : "") +
        '<button type="button" class="ba-full" data-full="pair:' + i + '" aria-label="Full screen">⤢</button></div>';
    });
    if (it.singles.length) out += '<div class="qc-singles">' + it.singles.map(function (s, i) { return '<button type="button" class="sg" data-full="single:' + i + '"><img data-shot="' + esc(s.name) + '" alt="' + esc(s.label) + '"><span>' + esc(s.label) + "</span></button>"; }).join("") + "</div>";
    return out + '<div class="qc-hint">' + (it.pairs.length ? "Drag to compare · ⤢ for full screen, pinch to zoom" : "Tap for full screen") + "</div></section>";
  }
  function prHtml(it) {
    if (!it.prs.length) return it.size ? '<section class="qc-sec"><div class="qc-pr nolink"><span class="pr-m"><b class="add">+' + it.size.added + '</b> <b class="del">−' + it.size.removed + "</b> lines changed in this terminal</span></div></section>" : "";
    return '<section class="qc-sec">' + it.prs.map(function (p) {
      var bits = [];
      if (it.size) bits.push('<b class="add">+' + it.size.added + '</b> <b class="del">−' + it.size.removed + "</b>");
      if (p.state) bits.push(esc(p.state));
      return '<a class="qc-pr" href="' + esc(p.url) + '" target="_blank" rel="noopener"><span class="pr-t">PR #' + p.num + (p.title ? " · " + esc(p.title) : "") + "</span>" +
        '<span class="pr-m">' + (bits.join(" · ") || esc(p.repo)) + "</span>" + ICON.ext + "</a>";
    }).join("") + "</section>";
  }
  function questionHtml(it) {
    var q = it.question;
    var opts = q.yn ? "" : q.options.map(function (o, i) { return '<button type="button" class="q-opt" data-opt="' + i + '">' + esc(o) + "</button>"; }).join("");
    return (q.note ? '<div class="q-note"><b>Robert:</b> ' + esc(q.note) + "</div>" : "") + (opts ? '<div class="q-opts">' + opts + "</div>" : "");
  }
  function draftHtml(it) {
    var d = it.draft;
    var where = d.kind === "email" ? "Gmail" : "Slack";
    return '<section class="qc-sec qc-draft"><div class="dr-to"><span>To</span><b>' + esc(d.to || d.channel || "—") + "</b><i>" + where + "</i></div>" +
      (d.subject ? '<div class="dr-sub">' + esc(d.subject) + "</div>" : "") +
      (d.text ? '<div class="dr-text">' + esc(d.text) + "</div>" : '<div class="dr-text partial">' + esc(d.label || "") + '<div class="dr-miss">The full text did not come through — open it in ' + where + " before you approve.</div></div>") +
      '<div class="dr-where">Nothing has been sent. It waits in ' + where + ' drafts — you send it. <a href="' + (d.kind === "email" ? "https://mail.google.com/mail/#drafts" : "slack://open") + '" target="_blank" rel="noopener">Open ' + where + "</a></div></section>";
  }
  function cardHtml(it) {
    var color = C.wsColor(it.ws), name = it.ws ? C.wsName(it.ws) : "";
    var head = '<div class="qc-top">' + (name ? '<span class="qc-ws" style="--c:' + esc(color) + '">' + esc(name) + "</span>" : "") +
      '<span class="qc-kind k-' + esc(it.kind.replace("+", "")) + '">' + esc(KIND_WORD[it.kind]) + '</span><span class="qc-age">' + ago(it.at) + "</span></div>";
    var asked = it.asked && it.kind !== "question" ? '<div class="qc-asked"><span>You asked</span>' + esc(it.asked) + "</div>" : it.kind === "question" && it.title ? '<div class="qc-asked"><span>From</span>' + esc(it.title) + "</div>" : "";
    var body = "";
    if (it.kind === "question") body += questionHtml(it);
    if (it.kind === "draft") body += draftHtml(it);
    if (it.kind === "blocked") body += '<div class="qc-sec qc-blocked">It stopped and is waiting for you. Say or type what it needs — it gets your words as they are.</div>';
    if (it.pairs || it.singles) body += shotsHtml(it);
    if (it.checks) body += checksHtml(it);
    if (it.prs) body += prHtml(it);
    if (it.summary && plain(it.summary).length > it.verdict.length + 8 || (it.changes && it.changes.length)) {
      body += '<details class="qc-sec qc-more"><summary>Details</summary>' + (it.summary ? '<div class="qc-sum">' + C.md(it.summary) + "</div>" : "") +
        (it.changes && it.changes.length ? '<div class="qc-h">What changed</div><ul>' + it.changes.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "") + "</details>";
    }
    if (it.note) body += '<div class="qc-note">' + esc(it.note) + "</div>";
    if (it.sid) body += '<button type="button" class="qc-term" data-term="' + esc(it.sid) + '">Open the terminal ' + ICON.chev + "</button>";
    return '<article class="qcard" data-key="' + esc(it.key) + '"><div class="qc-scroll">' + head + asked + '<h2 class="qc-verdict' + (it.verdict.length > 90 ? " long" : "") + '">' + esc(it.verdict) + "</h2>" + body + "</div></article>";
  }

  function barHtml(it) {
    if (!it) return "";
    if (it.kind === "question") {
      var q = it.question;
      if (q.yn) return '<button type="button" class="db no" data-d="opt:1">No</button><button type="button" class="db later" data-d="later">Later</button><button type="button" class="db yes" data-d="opt:0">Yes</button>';
      return (q.free ? '<button type="button" class="db" data-d="free">Reply</button>' : "") + '<button type="button" class="db later" data-d="later">Later</button>';
    }
    if (it.kind === "blocked") return '<button type="button" class="db" data-d="term">Open</button><button type="button" class="db later" data-d="later">Later</button><button type="button" class="db yes" data-d="reply">Reply</button>';
    var noText = it.kind === "draft" && (!it.draft.text || (it.src === "ledger" && !it.hashOk));
    return '<button type="button" class="db" data-d="change">Change</button><button type="button" class="db later" data-d="later">Later</button>' +
      '<button type="button" class="db yes" data-d="yes"' + (noText || (OK_LINE[it.kind] && !it.live) ? " disabled" : "") + ">" + esc(YES_WORD[it.kind] || "Yes") + "</button>";
  }

  function current() { return Q.items[D.idx] || null; }
  function render(keepKey) {
    if (!D.el) return;
    var items = Q.items;
    var want = keepKey || (current() && current().key);
    D.track.innerHTML = items.map(cardHtml).join("");
    D.keys = items.map(function (x) { return x.key; });
    var i = want ? D.keys.indexOf(want) : 0;
    D.idx = i < 0 ? Math.min(D.idx, Math.max(0, items.length - 1)) : i;
    D.track.scrollLeft = D.idx * D.track.clientWidth;
    paintHead();
    hydrate();
    wireCompare();
  }
  function paintHead() {
    var it = current();
    D.el.querySelector(".dk-pos").textContent = Q.items.length ? (D.idx + 1) + " of " + Q.items.length : "";
    D.el.querySelector(".dk-dots").innerHTML = Q.items.length > 1 ? Q.items.map(function (x, i) { return '<i class="' + (i === D.idx ? "on" : "") + '"></i>'; }).join("") : "";
    D.bar.innerHTML = barHtml(it);
    D.bar.hidden = !it;
    D.el.querySelector(".dk-empty").hidden = !!Q.items.length;
  }
  // Screenshots come through the admin-gated route as blobs (an <img src> cannot carry the header).
  // Only the card on screen and its neighbours load.
  function hydrate() {
    [D.idx - 1, D.idx, D.idx + 1].forEach(function (i) {
      var it = Q.items[i]; if (!it || !it.sid) return;
      var card = D.track.children[i]; if (!card) return;
      card.querySelectorAll("img[data-shot]").forEach(function (img) {
        if (img.getAttribute("src")) return;
        shotUrl(it.sid, img.dataset.shot).then(function (u) { img.src = u; }).catch(function () { img.alt = "screenshot unavailable"; img.classList.add("gone"); });
        if (img.classList.contains("ba-b")) img.addEventListener("load", function () {
          var ba = img.closest(".ba"), r = img.naturalWidth / img.naturalHeight;
          if (ba && r > 0) { ba.style.aspectRatio = String(r); ba.style.maxWidth = "min(100%, calc(56vh * " + r.toFixed(4) + "))"; }
        }, { once: true });
      });
      if (it.prs && it.prs.length) prFill(it, card);
    });
  }
  function shotUrl(sid, name) {
    var k = sid + "/" + name;
    if (D.shots.has(k)) return D.shots.get(k);
    var tok = C.token();
    var p = fetch("/api/sessions/" + sid + "/outcome/shot/" + encodeURIComponent(name), { headers: tok ? { "x-mc-admin": tok } : {} })
      .then(function (r) { return r.ok ? r.blob() : Promise.reject(new Error("gone")); })
      .then(function (b) { return URL.createObjectURL(b); });
    p.catch(function () { D.shots.delete(k); });
    D.shots.set(k, p);
    return p;
  }
  // The PR's own title, state and checks — `gh` on the daemon, cached there for 90 s.
  function prFill(it, card) {
    var a = ARTS.get(it.sid);
    var apply = function (prs) {
      var changed = false;
      it.prs.forEach(function (p) { var hit = prs.find(function (x) { return x.url === p.url; }); if (hit && (hit.title !== p.title || hit.state !== p.state || hit.ci !== p.ci)) { p.title = hit.title; p.state = hit.state; p.ci = hit.ci || null; changed = true; } });
      if (!changed || !card.isConnected) return;
      var sc = card.querySelector(".qc-scroll"), top = sc.scrollTop;
      var tmp = document.createElement("div"); tmp.innerHTML = cardHtml(it);
      card.querySelector(".qc-scroll").innerHTML = tmp.querySelector(".qc-scroll").innerHTML;
      card.querySelector(".qc-scroll").scrollTop = top;
      hydrate(); wireCompare();
    };
    if (a && Date.now() - a.t < 60000) return apply(a.prs);
    ARTS.set(it.sid, { t: Date.now(), prs: (a && a.prs) || [] });
    C.api("/sessions/" + it.sid + "/artifacts?urls=" + encodeURIComponent(it.prs.map(function (p) { return p.url; }).join(","))).then(function (r) {
      ARTS.set(it.sid, { t: Date.now(), prs: r.prs || [] });
      apply(r.prs || []);
    }).catch(function () {});
  }

  // ── the before/after compare (inline): drag anywhere on it ────────────────────────────────────
  function wireCompare() {
    D.track.querySelectorAll(".ba:not([data-w])").forEach(function (ba) {
      ba.dataset.w = "1";
      var drag = null;
      var setX = function (clientX) {
        var r = ba.getBoundingClientRect();
        var x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        ba.style.setProperty("--x", (x * 100).toFixed(1) + "%");
      };
      ba.addEventListener("pointerdown", function (e) {
        if (e.target.closest(".ba-full")) return;
        drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null };
      });
      ba.addEventListener("pointermove", function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
        if (!drag.axis && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
          drag.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
          if (drag.axis === "x") { try { ba.setPointerCapture(e.pointerId); } catch (x) {} }
        }
        if (drag.axis === "x") setX(e.clientX);
      });
      var end = function (e) {
        if (!drag || e.pointerId !== drag.id) return;
        var tap = !drag.axis;
        drag = null;
        if (tap && e.type === "pointerup") setX(e.clientX);
      };
      ba.addEventListener("pointerup", end);
      ba.addEventListener("pointercancel", end);
    });
  }

  // ── full-screen viewer: slide or flip, pinch zoom, pan, double-tap ──────────────────────────────
  var PV = null;
  function openViewer(it, which) {
    var parts = which.split(":"), i = Number(parts[1]);
    var pair = parts[0] === "pair" ? it.pairs[i] : null, single = parts[0] === "single" ? it.singles[i] : null;
    if (!pair && !single) return;
    var el = document.createElement("div");
    el.className = "pv"; el.setAttribute("role", "dialog");
    el.innerHTML = '<div class="pv-top"><button type="button" class="pv-x" aria-label="Close">' + ICON.x + "</button>" +
      (pair ? '<div class="pv-seg"><button type="button" data-mode="slide" class="on">Slide</button><button type="button" data-mode="flip">Flip</button></div>' : '<div class="pv-cap">' + esc(single.label || "") + "</div>") +
      '<span class="pv-z"></span></div><div class="pv-stage" style="--x:50%">' +
      (pair ? '<div class="pv-lay b"><img alt="before"></div><div class="pv-lay a"><img alt="after"></div><div class="pv-div"><span>' + ICON.grip + "</span></div>" +
        '<span class="pv-tag l">Before</span><span class="pv-tag r">After</span>' : '<div class="pv-lay b"><img alt=""></div>') +
      '</div><div class="pv-hint">' + (pair ? "Drag the line · pinch to zoom · double-tap" : "Pinch to zoom · double-tap") + "</div>";
    document.body.appendChild(el);
    var stage = el.querySelector(".pv-stage"), imgs = el.querySelectorAll(".pv-lay img");
    var st = { s: 1, x: 0, y: 0, mode: "slide", flip: false, w: 0, h: 0 };
    PV = { el: el, close: close };
    var apply = function () {
      imgs.forEach(function (im) { im.style.transform = "translate(" + st.x + "px," + st.y + "px) scale(" + st.s + ")"; });
      el.querySelector(".pv-z").textContent = st.s > 1.02 ? st.s.toFixed(1) + "×" : "";
      stage.classList.toggle("flip", st.mode === "flip"); stage.classList.toggle("showb", st.mode === "flip" && st.flip);
    };
    var clamp = function () {
      st.s = Math.max(1, Math.min(6, st.s));
      var r = stage.getBoundingClientRect();
      var maxX = (st.s - 1) * r.width, maxY = (st.s - 1) * r.height;
      st.x = Math.min(0, Math.max(-maxX, st.x)); st.y = Math.min(0, Math.max(-maxY, st.y));
    };
    var load = function (im, s) { shotUrl(it.sid, s.name).then(function (u) { im.src = u; }).catch(function () { im.alt = "unavailable"; }); };
    if (pair) { load(imgs[0], pair.before); load(imgs[1], pair.after); } else load(imgs[0], single);
    function close(fromHistory) {
      if (!PV || PV.el !== el) return;
      PV = null; el.classList.add("out"); setTimeout(function () { el.remove(); }, 180);
      if (!fromHistory && history.state && history.state.viewer && C.history) history.back();
    }
    if (C.history) history.pushState(Object.assign({}, history.state || {}, { viewer: true }), "");
    el.querySelector(".pv-x").onclick = function () { close(false); };
    el.querySelectorAll("[data-mode]").forEach(function (b) {
      b.onclick = function () { st.mode = b.dataset.mode; st.flip = false; el.querySelectorAll("[data-mode]").forEach(function (x) { x.classList.toggle("on", x === b); }); apply(); };
    });
    var P = new Map(), g = null, lastTap = 0;
    var setX = function (clientX) { var r = stage.getBoundingClientRect(); stage.style.setProperty("--x", (Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * 100).toFixed(1) + "%"); };
    stage.addEventListener("pointerdown", function (e) {
      try { stage.setPointerCapture(e.pointerId); } catch (x) {}
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var onDiv = !!e.target.closest(".pv-div");
      if (P.size === 2) {
        var a = Array.from(P.values());
        g = { kind: "pinch", d0: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), s0: st.s, x0: st.x, y0: st.y, mx: (a[0].x + a[1].x) / 2, my: (a[0].y + a[1].y) / 2 };
      } else g = { kind: onDiv || (pair && st.mode === "slide" && st.s <= 1.02) ? "slide" : "pan", sx: e.clientX, sy: e.clientY, x0: st.x, y0: st.y, moved: false, t: Date.now() };
    });
    stage.addEventListener("pointermove", function (e) {
      if (!P.has(e.pointerId)) return;
      P.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!g) return;
      if (g.kind === "pinch" && P.size === 2) {
        var a = Array.from(P.values()), r = stage.getBoundingClientRect();
        var d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
        var s = Math.max(1, Math.min(6, g.s0 * d / g.d0));
        var mx = g.mx - r.left, my = g.my - r.top;
        // Keep the point under the fingers where it was.
        st.x = mx - (mx - g.x0) * (s / g.s0); st.y = my - (my - g.y0) * (s / g.s0); st.s = s;
        clamp(); apply();
        return;
      }
      var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) g.moved = true;
      if (g.kind === "slide" && pair && st.mode === "slide") { setX(e.clientX); return; }
      if (g.kind === "pan" && st.s > 1.02) { st.x = g.x0 + dx; st.y = g.y0 + dy; clamp(); apply(); return; }
      if (st.s <= 1.02 && dy > 0) { el.style.setProperty("--pull", Math.min(1, dy / 300)); }
    });
    var up = function (e) {
      if (!P.has(e.pointerId)) return;
      P.delete(e.pointerId);
      if (!g) return;
      if (g.kind === "pinch") { if (P.size < 2) g = null; return; }
      var dy = e.clientY - g.sy;
      el.style.removeProperty("--pull");
      if (!g.moved && e.type === "pointerup") {
        var now = Date.now();
        if (now - lastTap < 300) {
          // Double-tap: zoom in where you tapped, or back out.
          var r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
          if (st.s > 1.02) { st.s = 1; st.x = 0; st.y = 0; } else { st.s = 2.5; st.x = px - px * 2.5; st.y = py - py * 2.5; clamp(); }
          lastTap = 0; apply();
        } else {
          lastTap = now;
          if (pair && st.mode === "flip") setTimeout(function () { if (lastTap === now) { st.flip = !st.flip; apply(); } }, 300);
          else if (pair && st.mode === "slide" && st.s <= 1.02) setX(e.clientX);
        }
      } else if (g.kind !== "slide" && st.s <= 1.02 && dy > 120) close(false);
      g = null;
    };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    apply();
  }

  // ── open / close / move ────────────────────────────────────────────────────────────────────────
  function open(key) {
    if (!D.el) return;
    if (!D.open) {
      D.open = true; D.el.hidden = false; D.el.classList.add("in");
      if (C.history) history.pushState(Object.assign({}, history.state || {}, { deck: true }), "");
      try { C.onOpen(true); } catch (e) {}
    }
    render(key);
    if (C.voice.on) readCard(current());
  }
  function close(fromHistory, keepVoice) {
    if (!D.open) return;
    if (PV) PV.close(true);
    D.open = false; D.el.hidden = true; D.el.classList.remove("in");
    VA.key = null;
    if (C.voice.on && !keepVoice) C.voice.skip(false, "card");
    if (!fromHistory && C.history && history.state && history.state.deck) history.back();
    try { C.onOpen(false); } catch (e) {}
  }
  function move(step) {
    var n = Math.max(0, Math.min(Q.items.length - 1, D.idx + step));
    D.track.scrollTo({ left: n * D.track.clientWidth, behavior: "smooth" });
  }
  function onScroll() {
    var w = D.track.clientWidth || 1, i = Math.round(D.track.scrollLeft / w);
    if (i === D.idx || i < 0 || i >= Q.items.length) return;
    D.idx = i;
    if (C.fx) C.fx.tick();
    paintHead(); hydrate();
    if (C.voice.on) readCard(current());
  }

  // A decision from a button. Yes waits 2.5 s with Undo (a pocket tap must not merge a PR); the rest
  // go now. The card leaves and the next one is already there.
  async function act(it, d, words, opt, viaVoice) {
    if (!it || D.busy) return null;
    if (d === "yes" && !viaVoice) {
      var key = it.key, undone = false;
      D.pending.add(key);
      dropCard(it);
      C.toast((YES_WORD[it.kind] || "Yes") + " · sending…", { label: "Undo", fn: function () { undone = true; D.pending.delete(key); Q.items.splice(Math.min(D.idx, Q.items.length), 0, it); if (!D.open) open(key); else render(key); changed(); } });
      await new Promise(function (r) { setTimeout(r, 2600); });
      if (undone) return null;
      D.pending.delete(key);
      return run(it, d, words, opt, true);
    }
    return run(it, d, words, opt, false);
  }
  async function run(it, d, words, opt, dropped, meta) {
    D.busy = true;
    try {
      var msg = await decide(it, d, words, opt, meta);
      if (!dropped) dropCard(it);
      if (C.fx) (d === "later" ? C.fx.tap() : C.fx.success());
      if (!C.voice.on || !D.open) C.toast(typeof msg === "string" ? msg : "Done");
      return msg;
    } catch (e) {
      if (dropped) { Q.items.splice(Math.min(D.idx, Q.items.length), 0, it); render(it.key); }
      if (C.fx) C.fx.fail();
      C.toast(String((e && e.message) || e).slice(0, 140));
      if (meta && meta.voice && C.voice.on && !(e && e.moved)) C.voice.say(t("No se pudo: ", "That didn't work: ") + String((e && e.message) || e).slice(0, 120), { tag: "card" });
      // The target moved (a newer PR head, a rewritten draft): never resent — reload, read it again.
      if (e && e.moved) { LED.delete(it.ledger && it.ledger.request); load().then(function () { if (D.open && C.voice.on) { C.voice.say(String(e.message), { tag: "card" }).then(function () { readCard(current()); }); } }); }
      return null;
    } finally { D.busy = false; changed(); }
  }
  function dropCard(it) {
    var i = Q.items.indexOf(it);
    if (i >= 0) Q.items.splice(i, 1);
    var next = Q.items[Math.min(i, Q.items.length - 1)];
    render(next && next.key);
    changed();
    if (!Q.items.length && D.open) setTimeout(function () { if (!Q.items.length) close(false, true); }, 700);
  }
  function changed() { try { C.onChange(Q.items.slice()); } catch (e) {} }

  async function onBar(d) {
    var it = current(); if (!it) return;
    if (C.fx) C.fx.tap();
    if (d === "later") return act(it, "later");
    if (d === "yes") return act(it, "yes");
    if (d === "term") { close(); return C.openTerminal(it.sid); }
    if (d.indexOf("opt:") === 0) return act(it, "yes", null, Number(d.slice(4)));
    if (d === "change" || d === "reply" || d === "free") {
      var words = await C.compose({
        title: d === "change" ? t("¿Qué tiene que cambiar?", "What should change?") : d === "reply" ? t("¿Qué le digo?", "What should it hear?") : t("Tu respuesta", "Your answer"),
        placeholder: d === "change" ? "e.g. keep the old colour" : "",
      });
      if (!words) return;
      return act(it, it.kind === "question" ? "yes" : "change", words, null);
    }
  }

  // ── voice: a card on screen during a call ──────────────────────────────────────────────────────
  // The page reads the card verdict-first and binds the next words to THAT card. Bound in code, not
  // trusted to a model: the card key + content signature captured when it was read must still be the
  // card on screen, and only an explicit affirmative (a short utterance made only of yes-words) is a
  // yes. Anything unclear is asked again. A draft is a yes only after its full text was played.
  var VA = { key: null, rev: null, verdict: false, read: false, unclear: 0, awaiting: null, pending: null };
  var YES_CORE = "si sip dale ok okay okey oka va vale listo perfecto bien aprobado aprobada apruebo aprobalo aprobala aprueba aprobar mergealo mergea mergear mergeo desplegalo despliega deployalo hacelo hazlo adelante correcto claro obvio yes yeah yep yup sure approve approved".split(" ");
  var YES_PHRASE = [" go ahead ", " do it ", " ship it ", " merge it ", " deploy it ", " send it ", " de una ", " si si "];
  var FILLER = "por favor gracias robert please thanks thank you entonces eh este esta la lo el nomas ya che bueno it then".split(" ");
  var NEG = "no not nope pero but espera wait aguanta momento cambia cambie change".split(" ");
  var LATER_RE = /^ (despues|mas tarde|luego|manana|later|not now|ahora no|en otro momento|dejalo|dejalo para despues|para despues|lo veo despues|despues lo veo|after|tomorrow)( (por favor|please|robert))? $/;
  var NEXT_RE = /^ (siguiente|el siguiente|la siguiente|proximo|proxima|next|otra|otro|pasa|pasala|pasalo|la que sigue) $/;
  var MORE_RE = /^ (mas|detalles|evidencia|pruebas|contame mas|que tests|que pruebas|lee la evidencia|leeme la evidencia|more|details|evidence|proof|read the proof|what tests) $/;
  var REPEAT_RE = /^ (repeti|repetime|repetir|repetilo|otra vez|de nuevo|como|que|que dijiste|repeat|again|say again|what) $/;
  var CLOSE_RE = /^ (cerrar|cerra|cerralo|salir|sali|volver|volve|listo por ahora|nada mas|basta de esto|close|exit|go back) $/;
  var WAIT_RE = /^ (espera|espera un momento|un momento|aguanta|wait|hold on|one sec) $/;
  // "No sé…" is not a no and not an answer: he is unsure, so nothing is decided.
  var UNSURE_RE = /^ (no se|no lo se|ni idea|no tengo idea|no estoy seguro|no estoy segura|no sabria|i dont know|i don t know|not sure|dunno|no idea)\b/;
  var CHANGE_HEAD = /^ (?:(?:no|pero|but)\s+)?(?:(?:pedile|decile|deci|tell it|ask it to|ask it)\s+)?(?:que\s+)?((?:cambia|cambie|cambiar|change|fix|arregla|arregle|corregi|corrige|corrija|modifica|modifique|agrega|agregue|saca|saque|quita|quite|pone|ponga|hace|haga|make|add|remove|use|usa|usa)\b.*)$/;
  var ORD = [[/\b(primera|primero|uno|1|first|one|la de arriba)\b/, 0], [/\b(segunda|segundo|dos|2|second|two)\b/, 1], [/\b(tercera|tercero|tres|3|third|three)\b/, 2], [/\b(cuarta|cuarto|cuatro|4|fourth|four)\b/, 3]];

  /** What an utterance means for this card. Pure (the tests drive it). */
  function intentOf(text, it) {
    var n = norm(text);
    var words = n.trim().split(" ").filter(Boolean);
    if (!words.length) return { type: "unclear" };
    if (CLOSE_RE.test(n)) return { type: "close" };
    if (UNSURE_RE.test(n)) return { type: "unclear" };
    if (WAIT_RE.test(n)) return { type: "wait" };
    if (REPEAT_RE.test(n)) return { type: "repeat" };
    if (MORE_RE.test(n)) return { type: "more" };
    if (LATER_RE.test(n)) return { type: "later" };
    if (NEXT_RE.test(n)) return { type: "next" };
    var q = it && it.question;
    // An option, by its order or its own words.
    if (q && q.options.length && !q.yn) {
      var hit = null;
      if (words.length <= 4) ORD.forEach(function (o) { if (hit == null && o[0].test(n) && o[1] < q.options.length) hit = o[1]; });
      if (hit == null && /\b(ultima|ultimo|last)\b/.test(n) && words.length <= 4) hit = q.options.length - 1;
      if (hit == null) {
        var scores = q.options.map(function (o) {
          var ow = norm(o).trim().split(" ").filter(function (w) { return w.length > 2; });
          if (!ow.length) return 0;
          return ow.filter(function (w) { return n.indexOf(" " + w + " ") >= 0; }).length / ow.length;
        });
        var best = -1, bi = -1, second = 0;
        scores.forEach(function (s, i) { if (s > best) { second = best; best = s; bi = i; } else if (s > second) second = s; });
        if (best >= 0.6 && best - Math.max(0, second) >= 0.25) hit = bi;
      }
      if (hit != null) return { type: "option", option: hit };
    }
    var ch = CHANGE_HEAD.exec(n);
    if (ch) return { type: "change", words: String(text).replace(/^\s*(no|pero|but)[\s,.:;!]+/i, "").trim() };
    if (/^ (si|yes) pero /.test(n) || /^ pero /.test(n)) return { type: "change", words: String(text).replace(/^\s*(s[ií]|yes)?[\s,]*(pero|but)[\s,.:;!]+/i, "").trim() };
    var free = /^ (decile|deci|respondele|contestale|tell it|answer|respond) (que )?(.+)$/.exec(n);
    if (free) return { type: "free", words: String(text).replace(/^\s*\S+\s+(que\s+)?/i, "").trim() };
    if (n === " no " || n === " nope " || n === " no gracias ") return { type: "no" };
    if (/^ no /.test(n) && words.length > 2) return { type: "change", words: String(text).replace(/^\s*no[\s,.:;!]+/i, "").trim() };
    // Yes: short, made only of yes-words and fillers, with at least one real yes-word — and not asked
    // back as a question ("¿sí?" is "really?", not approval).
    if (/[?¿]/.test(String(text))) return { type: "unclear" };
    var phrase = YES_PHRASE.some(function (p) { return n.indexOf(p) >= 0; });
    var core = words.some(function (w) { return YES_CORE.indexOf(w) >= 0; }) || phrase;
    var onlyYes = words.every(function (w) { return YES_CORE.indexOf(w) >= 0 || FILLER.indexOf(w) >= 0 || /^(go|ahead|do|ship|merge|deploy|send|de|una)$/.test(w); });
    var neg = words.some(function (w) { return NEG.indexOf(w) >= 0; });
    if (core && onlyYes && !neg && words.length <= 6) return { type: "yes" };
    return { type: "unclear" };
  }

  function readout(it) {
    var name = it.ws ? C.wsName(it.ws) + ". " : "";
    var head = name + it.verdict.replace(/[.!?]*$/, ".");
    var body = [], ask;
    if (it.kind === "question") {
      var q = it.question;
      if (q.note) body.push(t("Robert sugiere: ", "Robert suggests: ") + q.note);
      if (q.yn) ask = t("¿Sí o no?", "Yes or no?");
      else if (q.options.length) ask = t("Opciones: ", "Options: ") + q.options.join(t(", o ", ", or ")) + ".";
      else ask = t("¿Qué le respondo?", "What should I answer?");
      return { head: (it.title ? it.title + ". " : "") + t("Pregunta: ", "It asks: ") + plain(q.text), body: body, ask: ask };
    }
    if (it.kind === "draft") {
      var d = it.draft, where = d.kind === "email" ? t("un mail", "an email") : t("un mensaje de Slack", "a Slack message");
      head = name + t("Borrador: ", "A draft: ") + where + (d.to || d.channel ? t(" para ", " to ") + (d.to || d.channel) : "") + ".";
      if (d.subject) body.push(t("Asunto: ", "Subject: ") + d.subject + ".");
      if (d.text) body.push(t("Dice así: ", "It reads: ") + d.text);
      ask = d.text ? t("¿La apruebo? Sigue como borrador; la mandás vos.", "Approve it? It stays a draft; you send it.") : t("No me llegó el texto completo, así que no puedo darte el sí. Está en tus borradores.", "The full text did not come through, so I can't take a yes. It's in your drafts.");
      return { head: head, body: body, ask: ask };
    }
    if (it.kind === "blocked") return { head: name + t("Se frenó: ", "It stopped: ") + it.verdict + ".", body: [], ask: t("¿Qué le digo? O decí después.", "What should I tell it? Or say later.") };
    var fails = (it.checks || []).filter(function (g) { return g.state === "fail"; }).map(function (g) { return g.name.toLowerCase(); });
    var pass = (it.checks || []).filter(function (g) { return g.state === "pass"; }).map(function (g) { return g.name.toLowerCase(); });
    if (fails.length) body.push(t("Ojo: el agente reporta un problema en ", "Careful: the agent reports a problem with ") + fails.join(t(" y ", " and ")) + ".");
    else if (pass.length) body.push(t("Según el agente: ", "The agent says: ") + pass.map(function (p) { return { tests: t("los tests pasan", "tests pass"), "nothing else broke": t("no se rompió nada más", "nothing else broke"), review: t("lo revisaron", "it was reviewed"), "checked by hand": t("lo chequeó a mano", "it was checked by hand"), evidence: t("hay evidencia", "there is evidence") }[p] || p; }).join(t(", ", ", ")) + ".");
    else body.push(t("No dejó pruebas.", "It filed no proof."));
    if (it.pairs && it.pairs.length) body.push(t("Tenés el antes y el después en pantalla.", "The before and after are on screen."));
    ask = { merge: t("¿Lo mergeo?", "Merge it?"), deploy: t("¿Lo despliego?", "Deploy it?"), "merge+deploy": t("¿Lo mergeo y despliego?", "Merge and deploy it?"), review: t("¿Lo doy por leído?", "Mark it read?") }[it.kind];
    if (OK_LINE[it.kind] && !it.live) ask = t("La terminal ya terminó, así que no puedo pasarle el sí.", "Its terminal has ended, so I can't pass the yes on.");
    return { head: head, body: body, ask: ask };
  }
  function reprompt(it) {
    if (it.kind === "question") { var q = it.question; return q.yn ? t("¿Sí o no? O decí después.", "Yes or no? Or say later.") : q.options.length ? t("¿Cuál: ", "Which one: ") + q.options.join(t(" o ", " or ")) + t("? O decí después.", "? Or say later.") : t("¿Qué le respondo? O decí después.", "What should I answer? Or say later."); }
    if (it.kind === "blocked") return t("¿Qué le digo? O decí después.", "What should I tell it? Or say later.");
    var verb = { merge: t("¿Lo mergeo", "Merge it"), deploy: t("¿Lo despliego", "Deploy it"), "merge+deploy": t("¿Lo mergeo y despliego", "Merge and deploy"), review: t("¿Lo doy por leído", "Mark it read"), draft: t("¿La apruebo", "Approve it") }[it.kind];
    return verb + t(", lo dejo para después, o qué cambio?", ", later, or what should change?");
  }
  function readCard(it) {
    if (!it || !C.voice.on) return;
    C.voice.skip(false);
    var r = readout(it), key = it.key, rev = it.rev;
    VA = { key: key, rev: rev, verdict: false, read: false, unclear: 0, awaiting: null, pending: null };
    var tag = "card";
    C.voice.say(r.head, { tag: tag }).then(function (ok) { if (VA.key === key && ok) VA.verdict = true; });
    var bodyDone = r.body.length ? C.voice.say(r.body.join(" "), { tag: tag }) : Promise.resolve(true);
    bodyDone.then(function (ok) { if (VA.key === key && VA.rev === rev && ok) VA.read = true; });
    if (r.ask) C.voice.say(r.ask, { tag: tag });
  }
  function speakThen(text, next) {
    return C.voice.say(text, { tag: "card" }).then(function () { if (next) next(); });
  }
  function afterDecision(msg) {
    if (msg == null) return; // it failed: run() already said why
    var nxt = current();
    speakThen(msg, function () {
      if (!D.open) return;
      if (nxt) readCard(nxt); else C.voice.say(t("No queda nada.", "Nothing left."));
    });
  }
  /** A transcript during a call. True when the deck took it (it never reaches Robert then). */
  function voiceAnswer(text) {
    if (!D.open || !C.voice.on) return false;
    var it = current();
    if (!it) return false;
    // The card under the words must be the card that was read — else read the one on screen first.
    if (VA.key !== it.key || VA.rev !== it.rev) { readCard(it); return true; }
    var i = intentOf(text, it);
    if (VA.awaiting === "confirm") {
      var p = VA.pending;
      if (i.type === "yes") { VA.awaiting = null; VA.pending = null; run(it, p.d, p.words, null, false, { voice: true, words: text }).then(afterDecision); return true; }
      if (i.type === "later" || i.type === "no" || i.type === "close") { VA.awaiting = null; VA.pending = null; if (i.type === "close") { close(); return true; } C.voice.say(t("No lo mando. ", "Not sent. ") + reprompt(it), { tag: "card" }); return true; }
      if (i.type !== "unclear" && i.type !== "repeat") { VA.awaiting = null; VA.pending = null; }
      else { C.voice.say(t("Le digo: ", "I'll tell it: ") + p.words + t(". ¿Va?", ". OK?"), { tag: "card" }); return true; }
    }
    if (VA.awaiting === "words") {
      if (i.type === "later") { VA.awaiting = null; }
      else if (i.type === "close") { close(); return true; }
      else if (i.type !== "yes" && i.type !== "repeat" && plain(text).split(" ").length >= 2) {
        VA.awaiting = null;
        var dd = it.kind === "question" ? "yes" : "change";
        if (dd === "change" && it.kind !== "blocked") { run(it, "change", plain(text), null, false, { voice: true, words: text }).then(afterDecision); return true; }
        VA.awaiting = "confirm"; VA.pending = { d: dd, words: plain(text) };
        C.voice.say(t("Le digo: ", "I'll tell it: ") + plain(text) + t(". ¿Va?", ". OK?"), { tag: "card" });
        return true;
      }
    }
    switch (i.type) {
      case "close": close(); return true;
      case "wait": C.voice.skip(false, "card"); return true;
      case "repeat": readCard(it); return true;
      case "next": if (D.idx < Q.items.length - 1) move(1); else C.voice.say(t("Es la última.", "That's the last one."), { tag: "card" }); return true;
      case "more": {
        var lines = (it.proof || []).concat(it.changes || []);
        C.voice.say(lines.length ? lines.join(". ") : t("No hay más detalle.", "There's nothing more."), { tag: "card" }).then(function () { if (VA.key === it.key) C.voice.say(reprompt(it), { tag: "card" }); });
        return true;
      }
      case "later": run(it, "later", null, null, false, { voice: true, words: text }).then(afterDecision); return true;
      case "option": run(it, "yes", null, i.option, false, { voice: true, words: text }).then(afterDecision); return true;
      case "yes": {
        if (it.kind === "question") {
          var q = it.question, aff = q.yn ? 0 : q.options.findIndex(function (o) { return /^ (yes|si|ok|approve|approved|go|dale|keep) /.test(norm(o)) || norm(o).trim() === "yes"; });
          if (aff >= 0) { run(it, "yes", null, aff, false, { voice: true, words: text }).then(afterDecision); return true; }
          C.voice.say(reprompt(it), { tag: "card" }); return true;
        }
        if (it.kind === "blocked") { VA.awaiting = "words"; C.voice.say(t("¿Qué le digo?", "What should I tell it?"), { tag: "card" }); return true; }
        if (it.kind === "draft" && !it.draft.text) { C.voice.say(t("Sin el texto completo no puedo darte el sí. Abrilo en tus borradores.", "Without the full text I can't take a yes. Open it in your drafts."), { tag: "card" }); return true; }
        if (it.kind === "draft" && !VA.read) { C.voice.say(t("Primero te la leo entera.", "Let me read it all first."), { tag: "card" }).then(function () { if (VA.key === it.key) readCard(it); }); return true; }
        if (!VA.verdict) { readCard(it); return true; }
        if (OK_LINE[it.kind] && !it.live) { C.voice.say(t("La terminal ya terminó; no puedo pasarle el sí.", "Its terminal has ended; I can't pass the yes on."), { tag: "card" }); return true; }
        run(it, "yes", null, null, false, { voice: true, words: text }).then(afterDecision);
        return true;
      }
      case "change": if (i.words && plain(i.words).split(" ").length >= 2) { if (it.kind === "question" || it.kind === "blocked") { VA.awaiting = "confirm"; VA.pending = { d: it.kind === "question" ? "yes" : "change", words: i.words }; C.voice.say(t("Le digo: ", "I'll tell it: ") + i.words + t(". ¿Va?", ". OK?"), { tag: "card" }); return true; } run(it, "change", i.words, null, false, { voice: true, words: text }).then(afterDecision); return true; }
        VA.awaiting = "words"; C.voice.say(t("¿Qué cambio le pido?", "What should change?"), { tag: "card" }); return true;
      case "no":
        // A yes/no question: "no" is its answer, as explicit as "sí". Anywhere else it means "not like
        // this" — ask what should change.
        if (it.kind === "question" && it.question.yn) { run(it, "yes", null, 1, false, { voice: true, words: text }).then(afterDecision); return true; }
        VA.awaiting = "words"; C.voice.say(it.kind === "blocked" ? t("¿Qué le digo?", "What should I tell it?") : t("¿Qué querés que cambie?", "What should change?"), { tag: "card" });
        return true;
      case "free": if (it.kind === "question" || it.kind === "blocked") { VA.awaiting = "confirm"; VA.pending = { d: it.kind === "question" ? "yes" : "change", words: i.words }; C.voice.say(t("Le digo: ", "I'll tell it: ") + i.words + t(". ¿Va?", ". OK?"), { tag: "card" }); return true; }
        run(it, "change", i.words, null, false, { voice: true, words: text }).then(afterDecision); return true;
      default:
        VA.unclear++;
        if (VA.unclear <= 3) C.voice.say(t("No te entendí. ", "I didn't catch that. ") + reprompt(it) + (VA.unclear >= 2 ? t(" Para hablar con Robert, decí cerrar.", " To talk to Robert, say close.") : ""), { tag: "card" });
        return true;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────
  function init(ctx) {
    C = ctx;
    var el = ctx.el;
    D.el = el;
    el.innerHTML = '<div class="dk-head"><button type="button" class="dk-x" aria-label="Close">' + ICON.x + '</button><span class="dk-pos"></span>' +
      '<span class="dk-call" hidden><i></i><b></b><button type="button" class="dk-hang" aria-label="End the conversation"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="3"/></svg></button></span><span class="dk-dots"></span></div>' +
      '<div class="dk-track"></div><div class="dk-empty" hidden><b>All clear.</b><span>Nothing is waiting for you.</span></div><div class="dk-bar"></div>';
    D.track = el.querySelector(".dk-track"); D.bar = el.querySelector(".dk-bar");
    el.querySelector(".dk-x").onclick = function () { if (C.fx) C.fx.tap(); close(); };
    el.querySelector(".dk-hang").onclick = function () { if (C.fx) C.fx.tap(); C.voice.stop(); };
    var st = 0;
    D.track.addEventListener("scroll", function () { clearTimeout(st); st = setTimeout(onScroll, 60); }, { passive: true });
    D.bar.addEventListener("click", function (e) { var b = e.target.closest("[data-d]"); if (b && !b.disabled) onBar(b.dataset.d); });
    D.track.addEventListener("click", function (e) {
      var it = current(); if (!it) return;
      var full = e.target.closest("[data-full]"); if (full) { if (C.fx) C.fx.tap(); return openViewer(it, full.dataset.full); }
      var opt = e.target.closest("[data-opt]"); if (opt) { if (C.fx) C.fx.tap(); return act(it, "yes", null, Number(opt.dataset.opt)); }
      var term = e.target.closest("[data-term]"); if (term) { close(); return C.openTerminal(term.dataset.term); }
      var ck = e.target.closest("[data-ck]");
      if (ck) { var raw = ck.parentElement.querySelector('[data-ckraw="' + ck.dataset.ck + '"]'); if (raw) { raw.hidden = !raw.hidden; ck.classList.toggle("open", !raw.hidden); } return; }
      var sg = e.target.closest(".ba"); if (sg && !e.target.closest(".ba-full")) return;
    });
    addEventListener("resize", function () { if (D.open) D.track.scrollLeft = D.idx * D.track.clientWidth; });
    document.addEventListener("keydown", function (e) {
      if (!D.open) return;
      if (e.key === "Escape") { if (PV) PV.close(); else close(); }
      if (e.key === "ArrowRight") move(1);
      if (e.key === "ArrowLeft") move(-1);
    });
  }
  var loadT = 0, loading = null;
  async function load() {
    if (loading) { loading.again = true; return loading.p; }
    loading = { again: false, p: null };
    var me = loading;
    me.p = (async function () {
      try {
        var items = await loadQueue();
        // Keep a card that is mid-Undo out of the list until its timer settles.
        if (D.pending.size) items = items.filter(function (x) { return !D.pending.has(x.key); });
        Q.items = items; Q.loaded = true; Q.err = null;
      } catch (e) { Q.err = e; }
      if (D.open) render();
      changed();
    })();
    await me.p;
    loading = null;
    if (me.again) return load();
  }
  function loadSoon(ms) { clearTimeout(loadT); loadT = setTimeout(load, ms == null ? 350 : ms); }
  var TOPICS = ["session.updated", "session.status", "session.started", "session.ended", "agent.state", "ask.created", "ask.answered", "draft.ready"];
  function onEvent(e) {
    if (!e || TOPICS.indexOf(e.topic) < 0) return;
    if (e.topic === "session.updated" && e.session_id) DEC.delete(e.session_id);
    loadSoon(e.topic === "session.status" ? 800 : 350);
  }

  root.PhoneDeck = {
    init: init, load: load, loadSoon: loadSoon, open: open, close: close, onEvent: onEvent, TOPICS: TOPICS,
    items: function () { return Q.items.slice(); }, loaded: function () { return Q.loaded; },
    isOpen: function () { return D.open; }, current: current, readCurrent: function () { readCard(current()); },
    voiceAnswer: voiceAnswer, forSession: function (sid) { var it = Q.items.find(function (x) { return x.sid === sid; }); return it ? it.key : null; },
    has: function (key) { return Q.items.some(function (x) { return x.key === key; }); },
    viewerOpen: function () { return !!PV; }, closeViewer: function (fromHistory) { if (PV) PV.close(!!fromHistory); },
    KIND_WORD: KIND_WORD,
    // Pure helpers, for the tests (src/phone-deck.test.ts).
    _t: { intentOf: intentOf, groupProof: groupProof, lineFails: lineFails, pairShots: pairShots, firstSentence: firstSentence, handoffItem: handoffItem, questionItem: questionItem, draftItem: draftItem, blockedItem: blockedItem, readout: readout, decide: decide, setCtx: function (c) { C = c; }, OK_LINE: OK_LINE, hidden: hidden, record: record, draftHash: draftHash, draftCanon: draftCanon, ledgerItem: ledgerItem },
  };
})(typeof window !== "undefined" ? window : globalThis);

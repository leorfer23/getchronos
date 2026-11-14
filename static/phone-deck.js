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
 *   merge / deploy hand-off → POST /sessions/:id/approve, the Desk's own door: the daemon resolves the PR
 *                           and the commit from that terminal's hand-off, records his yes and types a line
 *                           naming them (src/card-approval-routes.ts) — the page never writes that line;
 *   a question            → the existing answer door (POST /asks/:id/answer, or the terminal's input);
 *   a draft               → nothing is sent (there is no executor, agents never send): his approval is
 *                           typed into the terminal that wrote it, as a record; he sends it himself;
 *   a read (review)       → marked read on this phone.
 *
 * ctx = { api, token(), toast(msg, act), fx, sessions(), visible(s), wsColor(id), wsName(id),
 *         input(id, body) → Promise, openTerminal(id), lang(), voice, md(text) → safe html,
 *         compose({title, placeholder}) → Promise<string|null>, onChange(items), onOpen(open),
 *         surface? — "phone" (default) or "desk": the label a decision is recorded under (`by`) }
 */
(function (root) {
  var C = null;
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var norm = function (t) { return " " + String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim() + " "; };
  var t = function (es, en) { return C && C.lang() === "es" ? es : en; };
  // What the operator calls his assistant (static/assistant-name.js; "Robert" when it is not loaded).
  var assistant = function () { return root.AssistantName ? root.AssistantName.get() : "Robert"; };

  // The cards whose yes is an approval for the terminal to carry out. What it covers is the daemon's to
  // say, never this page's: POST /sessions/:id/approve names the PR and the commit (approveInto below).
  var APPROVES = { merge: true, deploy: true, "merge+deploy": true };
  var KIND_WORD = { merge: "Merge", deploy: "Deploy", "merge+deploy": "Merge + deploy", review: "Read", question: "Question", blocked: "Stopped", draft: "Draft" };
  var RANK = { blocked: 0, question: 1, merge: 2, "merge+deploy": 2, deploy: 2, draft: 3, review: 4 };
  var YES_WORD = { merge: "Merge", deploy: "Deploy", "merge+deploy": "Merge + deploy", review: "Got it", draft: "Approve" };

  // ── local decisions (until the ledger records them) ───────────────────────────────────────────
  var DKEY = "phone-decided";
  function decided() { try { return JSON.parse(localStorage.getItem(DKEY) || "{}") || {}; } catch (e) { return {}; } }
  // `heard` = { words, how } for a decision taken by voice: the raw transcript and whether the yes was
  // strong, or a weak one confirmed after a re-ask. The phone's own record until the ledger has it.
  function record(key, d, until, heard) {
    var all = decided(), now = Date.now();
    for (var k in all) if (now - (all[k].at || 0) > 4 * 86400000) delete all[k];
    all[key] = { d: d, at: now, until: until || null };
    if (heard && heard.words) { all[key].words = String(heard.words).slice(0, 300); all[key].how = heard.how || null; }
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
      key: "handoff:" + s.id + ":" + (o.at || ""), kind: kind, ws: s.workspace_id, sid: s.id, live: !!s.live, outcomeAt: o.at || null,
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
    if (APPROVES[h.kind] && !led.bound) h.note = "Not verified at an exact version yet — your yes goes to the terminal for the commit GitHub has now, as on the Desk.";
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

  // ── everything the deck says out loud, in one place ──────────────────────────────────────────
  // Kept free of every word that counts as a yes (STRONG_YES / WEAK_YES below): if the phone's own
  // speaker leaks one of these lines back into the mic, it must never come back as his approval.
  // src/phone-deck.test.ts speaks each line for every card kind, in both languages, and fails if one
  // of them is ever taken for a yes.
  var SAY = {
    later: function () { return t("Te lo dejo para después.", "Later, then."); },
    // A yes/no answer is said back without its label: "Yes" would be the page saying a yes.
    answered: function (said, yn) {
      if (yn) return /^\s*no\b/i.test(String(said || "")) ? t("Le contesté que no.", "I answered no.") : t("Le contesté afirmativamente.", "I answered affirmatively.");
      return t("Le respondí: ", "Answered: ") + said + ".";
    },
    told: function () { return t("Se lo dije.", "Told it."); },
    askedFor: function (w) { return t("Le pedí: ", "Asked for: ") + w; },
    done: function (kind) { return { merge: t("Hecho. Le dije que mergee.", "Done — told it to merge."), deploy: t("Hecho. Le dije que despliegue.", "Done — told it to deploy."), "merge+deploy": t("Hecho. Le dije que mergee y despliegue.", "Done — told it to merge and deploy.") }[kind]; },
    recorded: function () { return t("Quedó registrado.", "Recorded."); },
    executed: function (kind) { return kind === "draft" ? t("Listo, se mandó.", "Done — it's sent.") : kind === "deploy" ? t("Listo, desplegado.", "Done — deployed.") : t("Listo, hecho.", "Done."); },
    draftToday: function (it) { var w = it.draft.kind === "email" ? "Gmail" : "Slack"; return t("Quedó tu aprobación. Sigue como borrador: lo mandás vos desde " + w + ".", "Your approval is recorded. It stays a draft — you send it from " + w + "."); },
    draftLedger: function () { return t("Quedó registrado. No se mandó nada: sigue en tus borradores.", "Recorded. Nothing was sent — it stays in your drafts."); },
    read: function () { return t("Marcado como leído.", "Marked read."); },
    moved: function () { return t("Cambió desde que lo viste — miralo de nuevo.", "It changed since you saw it — have another look."); },
    gone: function () { return t("Esa tarjeta ya no está; no hice nada.", "That card is gone; nothing was done."); },
    noExact: function () { return t("No tengo el texto completo de ese borrador; no puedo aprobarlo.", "I don't have that draft's full text, so I can't approve it."); },
    ended: function () { return t("Esa terminal ya terminó", "That terminal has ended"); },
    termEnded: function () { return t("La terminal ya terminó, así que no puedo pasarle tu aprobación.", "Its terminal has ended, so I can't pass your approval on."); },
    noFullText: function () { return t("Sin el texto completo no puedo aprobarlo. Abrilo en tus borradores.", "Without the full text I can't approve it. Open it in your drafts."); },
    readFirst: function () { return t("Primero te la leo entera.", "Let me read it all first."); },
    letMeFinish: function () { return t("Dejame terminar.", "Let me finish."); },
    tapInstead: function () { return t("Para este, tocá el botón en la pantalla.", "For this one, tap the button on the screen."); },
    notCaught: function () { return t("No te entendí.", "I didn't catch that."); },
    toRobert: function () { return t("Para hablar con " + assistant() + ", decí cerrar.", "To talk to " + assistant() + ", say close."); },
    nothingLeft: function () { return t("No queda nada.", "Nothing left."); },
    lastOne: function () { return t("Esta es la final.", "This is the final card."); },
    nothingMore: function () { return t("No hay más detalle.", "There's nothing more."); },
    whatToTell: function () { return t("¿Qué le digo?", "What should I tell it?"); },
    whatChange: function () { return t("¿Qué querés que cambie?", "What should change?"); },
    sendThis: function (w) { return t("Le digo: ", "I'll tell it: ") + w + t(". ¿Lo mando?", ". Shall I send that?"); },
    notSent: function () { return t("No lo mando.", "Not sent."); },
    failed: function (m) { return t("No se pudo: ", "That didn't work: ") + m; },
    // A weak acknowledgement on something that cannot be undone: asked once more, never acted on.
    weak: function (kind) { return { merge: t("¿Confirmás el merge?", "Confirm the merge?"), deploy: t("¿Confirmás el despliegue?", "Confirm the deploy?"), "merge+deploy": t("¿Confirmás el merge y el despliegue?", "Confirm the merge and the deploy?"), draft: t("¿Confirmás tu aprobación del borrador?", "Confirm your approval of the draft?") }[kind]; },
    // Said before an irreversible action, with the window to stop it.
    hold: function (it) {
      var what = shortTitle(it);
      var to = it.draft ? it.draft.to || it.draft.channel || "" : "";
      return ({ merge: t("Mergeo ", "Merging ") + what, deploy: t("Despliego ", "Deploying ") + what, "merge+deploy": t("Mergeo y despliego ", "Merging and deploying ") + what,
        draft: t("Apruebo el borrador", "Approving the draft") + (to ? t(" para ", " to ") + to : "") }[it.kind]).replace(/([^…])$/, "$1.") + " " + t("Decí cancelar para frenar.", "Say cancel to stop.");
    },
    cancelled: function () { return t("Cancelado. No hice nada.", "Cancelled. Nothing was done."); },
  };
  function shortTitle(it) {
    var w = plain(it.title || it.verdict || "").replace(/[.!?]+$/, "").split(" ");
    return w.slice(0, 8).join(" ") + (w.length > 8 ? "…" : "");
  }
  var heardOf = function (meta) { return meta && meta.voice ? { words: meta.words || null, how: meta.how || null } : null; };

  /**
   * Carry one decision back — TODAY through the doors that already exist (see the header). Returns
   * what to tell him. `words` is his own text for change / a free answer; `opt` an option index.
   * What is TYPED into a terminal is only the decision (the Desk's approval line, his change words, his
   * answer) — never the transcript of how he said yes; that goes to the record (ledger `words`, or here).
   */
  async function decide(it, d, words, opt, meta) {
    var sid = it.sid;
    var heard = heardOf(meta);
    var typeInto = function (text) {
      if (!sid || !it.live) throw new Error(SAY.ended());
      return C.input(sid, { text: text, enter: true });
    };
    if (it.src === "ledger" && it.ledger) return decideLedger(it, d, words, opt, meta || {}, typeInto);
    if (d === "later") {
      if (it.kind === "question" && it.askId) {
        // A real "later" exists for questions: date it off the live list (holds.ts).
        await C.api("/asks/" + it.askId + "/hold", { method: "POST", body: JSON.stringify({ until: "+2h", reason: "later, from the phone" }) });
      }
      record(it.key, "later", Date.now() + 2 * 3600000, heard);
      return SAY.later();
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
      record(it.key, "yes", null, heard);
      return SAY.answered(said, q.yn);
    }
    if (it.kind === "blocked") {
      if (d !== "change" || !words) throw new Error("say what to tell it");
      await typeInto(words);
      record(it.key, "change", null, heard);
      return SAY.told();
    }
    if (d === "change") {
      if (!words) throw new Error("say what should change");
      if (it.kind === "draft") await typeInto("Change the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + ": " + words);
      else await typeInto("Changes needed: " + words);
      record(it.key, "change", null, heard);
      return SAY.askedFor(words);
    }
    // d === "yes"
    if (APPROVES[it.kind]) {
      await approveInto(it, null);
      record(it.key, "yes", null, heard);
      return SAY.done(it.kind);
    }
    if (it.kind === "draft") {
      // Nothing is sent: there is no executor and agents never send. The yes is recorded where one can
      // be today — the terminal that wrote it — and here.
      if (sid && it.live) await typeInto("Approved: the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + " is good as written. Leave it as a draft — I'll send it myself.").catch(function () {});
      record(it.key, "yes", null, heard);
      return SAY.draftToday(it);
    }
    if (it.kind === "review") { record(it.key, "read", null, heard); return SAY.read(); }
    throw new Error("nothing to approve");
  }

  /**
   * A decision on a ledger item: recorded there (POST /api/ledger/:id/decision — his hand only, it
   * executes nothing). What still has to happen today happens through today's doors: a change reaches
   * the terminal as words, and a merge/deploy whose target the verifier has not bound yet (the ledger
   * refuses that yes) is delivered to the terminal as the Desk does. A 409 means the target moved since
   * the card was drawn: nothing is resent — the card is read again and he decides again. A decision
   * taken by voice carries the raw transcript (`words`) and how it was given (`by`: strong yes, or a
   * weak one confirmed after a re-ask).
   */
  /**
   * What follows a recorded yes, from the decision route's answer (the executor puts `executed` on it):
   *   executed === true  → it already ran: say so, and type NOTHING into the terminal (no second merge);
   *   executed === false → the executor did not run it: the terminal is told the Desk's way (approveInto),
   *                        so the agent carries it out — that PR, at that commit;
   *   no field           → today's behaviour: recorded, nothing typed.
   */
  function yesFollowUp(resp) {
    if (resp && resp.executed === true) return "executed";
    if (resp && resp.executed === false) return "type";
    return "recorded";
  }
  async function decideLedger(it, d, words, opt, meta, typeInto) {
    var L = it.ledger;
    // The surface he decided on: "phone" / "desk" for a tap or a click, "<surface>-voice:<how>" for a
    // spoken yes (src/executor.ts howOf / surfaceOf read exactly this shape).
    var where = C.surface === "desk" ? "desk" : "phone";
    var by = meta.voice ? (where + "-voice:" + (meta.how || "strong")).slice(0, 40) : where;
    var post = function (decision, extra) {
      return C.api("/ledger/" + L.request + "/decision", {
        method: "POST", headers: { "x-mc-operator": "1" },
        body: JSON.stringify(Object.assign({ item: L.item, decision: decision, by: by }, extra || {})),
      }).catch(function (e) {
        if (e && e.status === 409) { var x = new Error(SAY.moved()); x.moved = true; throw x; }
        throw e;
      });
    };
    if (it.kind === "question") {
      // Answered on the ask; the ledger follows it (LEDGER.md) — one decision, written once.
      var q = it.question, said = opt != null ? q.options[opt] : words;
      if (d === "later") { await post("later", { until: "+2h", words: meta.words || null }); return SAY.later(); }
      if (!said) throw new Error("no answer");
      if (it.askId) await C.api("/asks/" + it.askId + "/answer", { method: "POST", body: JSON.stringify({ answer: said, by: "operator" }) });
      else await post("change", { words: said });
      return SAY.answered(said, q.yn);
    }
    if (d === "later") { await post("later", { until: "+2h", words: meta.words || null }); return SAY.later(); }
    if (d === "change") {
      if (!words) throw new Error("say what should change");
      await post("change", { words: words });
      if (sid(it)) await typeInto(it.kind === "draft" ? "Change the draft" + (it.draft.to || it.draft.channel ? " to " + (it.draft.to || it.draft.channel) : "") + ": " + words : "Changes needed: " + words).catch(function () {});
      return SAY.askedFor(words);
    }
    // yes
    if (APPROVES[it.kind]) {
      if (!L.bound) {
        // The ledger cannot take this yes yet (no bound PR head): the Desk's way, said on the card — the
        // daemon binds it to the commit GitHub has now and records it on this item — and kept on this phone
        // so the card does not come back while the ledger waits for the PR to settle.
        await approveInto(it, { ledger: { request: L.request, item: L.item } });
        record(it.key, "yes", null, heardOf(meta));
        return SAY.done(it.kind);
      }
      var follow = yesFollowUp(await post("yes", { target_hash: L.target_hash, words: meta.words || null }));
      if (follow === "executed") return SAY.executed(it.kind);
      // Bound to the head he was shown: a PR that moved since is never merged — the terminal hands off again.
      if (follow === "type") { await approveInto(it, { ledger: { request: L.request, item: L.item } }); return SAY.done(it.kind); }
      return SAY.recorded();
    }
    if (it.kind === "draft") {
      if (!it.draft.text || !it.hashOk) throw new Error(SAY.noExact());
      // A draft is never typed anywhere as an approval line: executed or recorded, nothing else.
      return yesFollowUp(await post("yes", { target_hash: L.target_hash, words: meta.words || null })) === "executed" ? SAY.executed("draft") : SAY.draftLedger();
    }
    await post("yes", { words: meta.words || null });
    return it.kind === "review" ? SAY.read() : SAY.recorded();
  }
  function sid(it) { return !!(it.sid && it.live); }
  /**
   * The approval itself, for a merge / deploy card: which kind, the hand-off the card was drawn from and,
   * for a ledger card, its request item — never a line of text. The daemon refuses a card that moved
   * (409: a newer hand-off, a PR whose head changed — the terminal is then told to hand off again).
   */
  function approveInto(it, extra) {
    if (!it.sid || !it.live) return Promise.reject(new Error(SAY.ended()));
    var body = { kind: it.kind, surface: C.surface === "desk" ? "desk" : "phone" };
    if (it.outcomeAt) body.outcome_at = it.outcomeAt;
    if (extra && extra.ledger) body.ledger = extra.ledger;
    return C.api("/sessions/" + it.sid + "/approve", { method: "POST", headers: { "x-mc-operator": "1" }, body: JSON.stringify(body) })
      .catch(function (e) {
        if (e && e.status === 409) { var x = new Error(SAY.moved()); x.moved = true; throw x; }
        throw e;
      });
  }

  // ── rendering ──────────────────────────────────────────────────────────────────────────────────
  var D = { el: null, track: null, bar: null, open: false, idx: 0, keys: [], pending: new Set(), shots: new Map(), busy: false };
  var ICON = {
    x: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    ext: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
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
    var mouse = C.surface === "desk";
    return out + '<div class="qc-hint">' + (it.pairs.length ? (mouse ? "Drag to compare · ⤢ for full screen, scroll to zoom" : "Drag to compare · ⤢ for full screen, pinch to zoom") : (mouse ? "Click for full screen" : "Tap for full screen")) + "</div></section>";
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
    return (q.note ? '<div class="q-note"><b>' + esc(assistant()) + ':</b> ' + esc(q.note) + "</div>" : "") + (opts ? '<div class="q-opts">' + opts + "</div>" : "");
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
    // Three blocks in reading order — what it is, the screenshots, the evidence. On a phone they
    // stack as they always did; on a wide screen the screenshots sit beside the other two (.qc-cols).
    var lead = "", shots = "", body = "";
    if (it.kind === "question") lead += questionHtml(it);
    if (it.kind === "draft") lead += draftHtml(it);
    if (it.kind === "blocked") lead += '<div class="qc-sec qc-blocked">It stopped and is waiting for you. Say or type what it needs — it gets your words as they are.</div>';
    if (it.pairs || it.singles) shots = shotsHtml(it);
    if (it.checks) body += checksHtml(it);
    if (it.prs) body += prHtml(it);
    if (it.summary && plain(it.summary).length > it.verdict.length + 8 || (it.changes && it.changes.length)) {
      body += '<details class="qc-sec qc-more"><summary>Details</summary>' + (it.summary ? '<div class="qc-sum">' + C.md(it.summary) + "</div>" : "") +
        (it.changes && it.changes.length ? '<div class="qc-h">What changed</div><ul>' + it.changes.map(function (c) { return "<li>" + esc(c) + "</li>"; }).join("") + "</ul>" : "") + "</details>";
    }
    if (it.note) body += '<div class="qc-note">' + esc(it.note) + "</div>";
    if (it.sid) body += '<button type="button" class="qc-term" data-term="' + esc(it.sid) + '">Open the terminal ' + ICON.chev + "</button>";
    return '<article class="qcard" data-key="' + esc(it.key) + '"><div class="qc-scroll"><div class="qc-cols"><div class="qc-a">' + head + asked + '<h2 class="qc-verdict' + (it.verdict.length > 90 ? " long" : "") + '">' + esc(it.verdict) + "</h2>" + lead + "</div>" + shots + '<div class="qc-b">' + body + "</div></div></div></article>";
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
      '<button type="button" class="db yes" data-d="yes"' + (noText || (APPROVES[it.kind] && !it.live) ? " disabled" : "") + ">" + esc(YES_WORD[it.kind] || "Yes") + "</button>";
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
    clearTimeout(headT); D.dest = null; // drawn where it stands: not on its way anywhere
    paintHead();
    hydrate();
    wireCompare();
  }
  function paintHead() {
    var it = current();
    D.el.querySelector(".dk-pos").textContent = Q.items.length ? (D.idx + 1) + " of " + Q.items.length : "";
    D.el.querySelector(".dk-nav").hidden = Q.items.length < 2;
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
          if (ba && r > 0) { ba.style.aspectRatio = String(r); ba.style.maxWidth = "min(100%, calc(var(--ba-h, 56vh) * " + r.toFixed(4) + "))"; }
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
      '</div><div class="pv-hint">' + (C.surface === "desk" ? (pair ? "Drag the line · scroll to zoom · double-click · Esc" : "Scroll to zoom · double-click · Esc") : (pair ? "Drag the line · pinch to zoom · double-tap" : "Pinch to zoom · double-tap")) + "</div>";
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
    // A mouse has no pinch: the wheel (and a trackpad's pinch, which arrives as ctrl+wheel) zooms
    // around the pointer.
    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = stage.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      var s = Math.max(1, Math.min(6, st.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022))));
      st.x = px - (px - st.x) * (s / st.s); st.y = py - (py - st.y) * (s / st.s); st.s = s;
      clamp(); apply();
    }, { passive: false });
    apply();
  }

  // ── open / close / move ────────────────────────────────────────────────────────────────────────
  function open(key) {
    if (!D.el) return;
    if (!D.open) {
      D.open = true; D.el.hidden = false; D.el.classList.add("in");
      // Whatever had the keyboard (the composer) lets go: a key pressed over the deck types nowhere.
      try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
      if (C.history) history.pushState(Object.assign({}, history.state || {}, { deck: true }), "");
      try { C.onOpen(true); } catch (e) {}
    }
    render(key);
    if (C.voice.on) readCard(current());
  }
  function close(fromHistory, keepVoice) {
    if (!D.open) return;
    if (PV) PV.close(true);
    cancelHold(true); // leaving the deck stops a held yes
    D.open = false;
    if (D.el) { D.el.hidden = true; D.el.classList.remove("in"); }
    VA.key = null;
    if (C.voice.on && !keepVoice) C.voice.skip(false, "card");
    if (!fromHistory && C.history && history.state && history.state.deck) history.back();
    try { C.onOpen(false); } catch (e) {}
  }
  function move(step) {
    var n = Math.max(0, Math.min(Q.items.length - 1, D.idx + step));
    heading(n);
    D.track.scrollTo({ left: n * D.track.clientWidth, behavior: "smooth" });
  }
  // The deck is on its way to another card (←/→, ‹ ›, a swipe let go): until it gets there the bar
  // still names the card it left, so nothing on it or on a card answers (settled()). Cleared when the
  // track arrives, and by the clock in case it never moves.
  var headT = 0;
  function heading(n) {
    clearTimeout(headT);
    D.dest = n === D.idx ? null : n;
    if (D.dest != null) { headT = setTimeout(function () { D.dest = null; }, 1200); if (headT && headT.unref) headT.unref(); }
  }
  function onScroll() {
    var w = D.track.clientWidth || 1, i = Math.round(D.track.scrollLeft / w);
    if (i === D.dest) { clearTimeout(headT); D.dest = null; } // arrived
    if (i === D.idx || i < 0 || i >= Q.items.length) return;
    D.idx = i; D.dest = null;
    if (C.fx) C.fx.tick();
    paintHead(); hydrate();
    if (C.voice.on) readCard(current());
  }

  // ── swipe between cards (touch) ────────────────────────────────────────────────────────────────
  // A finger moves the deck: left = next card, right = previous; the cards follow it and snap. A swipe
  // only ever NAVIGATES — nothing in here can reach decide(): Yes · Later · Change stay taps.
  // It does not start on a link or a field, on the before/after compare, on a block that scrolls
  // sideways itself (code, a table, the row of screenshots), over selected text, or at the screen's
  // edge (Android's back gesture). It only takes the gesture after a clear horizontal intent, so a
  // long card still scrolls up and down (the cards are touch-action:pan-y: the browser keeps vertical).
  var SWIPE = { lockPx: 12, ratio: 1.5, edgePx: 24, goFrac: 0.22, flickPx: 40, flickMs: 260 };
  /** May a swipe start on this element? Pure: only closest / parentElement / scrollWidth / clientWidth. */
  function swipeStartOk(target) {
    if (!target || !target.closest) return false;
    if (!target.closest(".qcard")) return false;
    // A row of a card is often a button (a check, an option): a swipe may start on one — once it is a
    // swipe, the click that would follow is swallowed (wireSwipe), so it still decides nothing.
    if (target.closest("a, input, textarea, select, [contenteditable], .ba, .pv")) return false;
    for (var n = target; n && !(n.classList && n.classList.contains("qcard")); n = n.parentElement) {
      if ((n.scrollWidth || 0) > (n.clientWidth || 0) + 4) return false;
    }
    return true;
  }
  /** What a finger that moved (dx, dy) from where it landed means: "navigate", "ignore" (a scroll, a diagonal), or "wait". */
  function swipeIntent(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax > SWIPE.lockPx && ax > SWIPE.ratio * ay) return "navigate";
    if (ax > SWIPE.lockPx || ay > SWIPE.lockPx) return "ignore";
    return "wait";
  }
  /** The card a released swipe lands on: one step at most, past a fifth of the width or on a quick flick. */
  function swipeTarget(idx, count, dx, width, ms) {
    var far = Math.abs(dx) > (width || 1) * SWIPE.goFrac, flick = Math.abs(dx) > SWIPE.flickPx && ms < SWIPE.flickMs;
    var step = far || flick ? (dx < 0 ? 1 : -1) : 0;
    return Math.max(0, Math.min(Math.max(0, count - 1), idx + step));
  }
  function wireSwipe(track) {
    var g = null, snapT = 0, swiped = 0;
    // The click a browser may still fire on the button the finger landed on, after a swipe: never a tap.
    track.addEventListener("click", function (e) {
      if (Date.now() - swiped < 500) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    var snapTo = function (n) {
      var still = root.matchMedia && root.matchMedia("(prefers-reduced-motion: reduce)").matches;
      heading(n);
      track.scrollTo({ left: n * track.clientWidth, behavior: still ? "auto" : "smooth" });
      // The track's own snapping comes back once it has arrived (it would yank the card mid-glide).
      clearTimeout(snapT); snapT = setTimeout(function () { track.style.scrollSnapType = ""; }, still ? 0 : 420);
    };
    track.addEventListener("pointerdown", function (e) {
      g = null;
      if (e.pointerType === "mouse" || e.isPrimary === false || PV || Q.items.length < 2) return;
      var vw = root.innerWidth || track.clientWidth || 0;
      if (e.clientX < SWIPE.edgePx || e.clientX > vw - SWIPE.edgePx) return;
      if (!swipeStartOk(e.target)) return;
      var sel = root.getSelection && root.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(), lock: false, idx0: D.idx, left0: D.idx * track.clientWidth };
    });
    track.addEventListener("pointermove", function (e) {
      if (!g || e.pointerId !== g.id) return;
      var dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.lock) {
        var i = swipeIntent(dx, dy);
        if (i === "ignore") { g = null; return; }
        if (i !== "navigate") return;
        g.lock = true; clearTimeout(snapT); swiped = Date.now();
        track.style.scrollSnapType = "none";
        try { track.setPointerCapture(e.pointerId); } catch (x) {}
      }
      track.scrollLeft = g.left0 - dx;
    });
    var end = function (e) {
      if (!g || e.pointerId !== g.id) return;
      var was = g; g = null;
      if (!was.lock) return;
      swiped = Date.now();
      snapTo(e.type === "pointerup" ? swipeTarget(was.idx0, Q.items.length, e.clientX - was.x0, track.clientWidth, Date.now() - was.t0) : was.idx0);
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
  }

  // A decision from a button. Yes waits 2.5 s with Undo (a pocket tap must not merge a PR); the rest
  // go now. The card leaves and the next one is already there.
  async function act(it, d, words, opt, viaVoice) {
    if (!it || D.busy) return null;
    // A tap decides: a spoken yes still being held is dropped first — never both.
    if (VA.hold) cancelHold(true);
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
      if (meta && meta.voice && C.voice.on && !(e && e.moved)) C.voice.say(SAY.failed(String((e && e.message) || e).slice(0, 120)), { tag: "card" });
      // The target moved (a newer PR head, a rewritten draft): never resent — reload, read it again.
      if (e && e.moved) { LED.delete(it.ledger && it.ledger.request); load().then(function () { if (D.open && C.voice.on) { C.voice.say(String(e.message), { tag: "card" }).then(function () { readCard(current()); }); } }); }
      return null;
    } finally { D.busy = false; changed(); }
  }
  function dropCard(it) {
    // The next card slides in under the finger (or the pointer) that just decided this one, its Yes
    // exactly where this one's was: for a moment its buttons answer nothing, so a double tap or a
    // double click is one decision, never one on each card.
    D.cool = Date.now() + 700;
    var i = Q.items.indexOf(it);
    if (i >= 0) Q.items.splice(i, 1);
    var next = Q.items[Math.min(i, Q.items.length - 1)];
    render(next && next.key);
    changed();
    if (!Q.items.length && D.open) setTimeout(function () { if (!Q.items.length) close(false, true); }, 700);
  }
  function changed() { try { C.onChange(Q.items.slice()); } catch (e) {} }

  // Is the card the bar belongs to the one on screen? Between a swipe (or ←/→) and the moment the
  // track settles, the bar still names the previous card: a click in that gap decides nothing.
  function settled() {
    if (D.dest != null || Date.now() < (D.cool || 0)) return false;
    if (!D.track || !D.track.clientWidth) return true;
    return Math.abs(D.track.scrollLeft - D.idx * D.track.clientWidth) < D.track.clientWidth * 0.25;
  }
  async function onBar(d) {
    var it = current(); if (!it) return;
    if (!settled()) return;
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
  // The page reads the card verdict-first and binds the next words to THAT card — in code, never a
  // model's reading of them. A decision counts only when all of these hold:
  //   · the card under the words is the card that was read (key + content signature);
  //   · the words STARTED after the card's question finished playing, and no page audio played while
  //     he spoke (the call's own playback clock: meta.t0 / meta.overlap from phone-voice.js) — the
  //     phone's speaker leaking its own question back into the mic is never his answer;
  //   · the echo guard did not flag them (phone-voice.js drops those before they get here);
  //   · they are an explicit yes: a short utterance made only of yes-words — and no word the page itself
  //     says for this card counts (the vocabulary minus pageWords(card), built from the actual lines).
  // On something irreversible (merge, deploy, a draft) only a STRONG yes counts; a weak one ("ok",
  // "bien", "listo"…) is asked once more and never acted on; and the yes is held for a few seconds,
  // said out loud, and stopped by "cancelar"/"no"/"pará"/any barge-in — the voice twin of Undo.
  var VA = { key: null, rev: null, verdict: false, read: false, askEndedAt: null, unclear: 0, awaiting: null, pending: null, weak: null, hold: null };
  var HOLD_MS = 4000;
  var HOLD_WAIT_MS = 6000; // the longest the window waits for words he started inside it
  var nowMs = function () { return root.performance && root.performance.now ? root.performance.now() : Date.now(); };
  var IRREVERSIBLE = { merge: true, deploy: true, "merge+deploy": true, draft: true };
  // A strong yes: what a person says when he means it. Imperatives the page never says itself.
  var STRONG_YES = "si dale yes adelante hacelo hazlo mergealo desplegalo deployalo aprobado aprobada aprobalo aprobala approved".split(" ");
  var STRONG_PHRASE = [" go ahead ", " do it ", " ship it ", " merge it ", " deploy it ", " de una "];
  // What a person mutters while listening: a yes for a question or a read, never for a merge.
  var WEAK_YES = "ok okay okey oka bien listo perfecto claro obvio va vale bueno correcto exacto genial joya sip sure yeah yup yep fine alright".split(" ");
  var FILLER = "por favor gracias robert please thanks thank you eh este esta nomas ya che entonces then".split(" ");
  // His assistant's name is filler too ("sí, ada"), whatever he named it (static/assistant-name.js).
  function nameWords() { var AN = root.AssistantName; return AN ? AN.words() : "robert"; }
  function isFiller(w) { return FILLER.indexOf(w) >= 0 || (" " + nameWords().split("|").join(" ") + " ").indexOf(" " + w + " ") >= 0; }
  var NEG = "no not nope pero but espera wait aguanta momento cambia cambie change cancelar cancel".split(" ");
  var OPT_FILLER = "la el de que quiero elijo opcion option the one por favor please".split(" ");
  var LATER_WORDS = "despues|mas tarde|luego|manana|later|not now|ahora no|en otro momento|dejalo|dejalo para despues|para despues|lo veo despues|despues lo veo|after|tomorrow";
  var LATER_RE = { test: function (n) { return new RegExp("^ (" + LATER_WORDS + ")( (por favor|please|" + nameWords() + "))? $").test(n); } };
  var NEXT_RE = /^ (siguiente|el siguiente|la siguiente|proximo|proxima|next|otra|otro|pasa|pasala|pasalo|la que sigue) $/;
  var MORE_RE = /^ (mas|detalles|evidencia|pruebas|contame mas|que tests|que pruebas|lee la evidencia|leeme la evidencia|more|details|evidence|proof|read the proof|what tests) $/;
  var REPEAT_RE = /^ (repeti|repetime|repetir|repetilo|otra vez|de nuevo|como|que|que dijiste|repeat|again|say again|what) $/;
  var CLOSE_RE = /^ (cerrar|cerra|cerralo|salir|sali|volver|volve|listo por ahora|nada mas|basta de esto|close|exit|go back) $/;
  var WAIT_RE = /^ (espera|espera un momento|un momento|aguanta|wait|hold on|one sec) $/;
  // "No sé…" is not a no and not an answer: he is unsure, so nothing is decided.
  var UNSURE_RE = /^ (no se|no lo se|ni idea|no tengo idea|no estoy seguro|no estoy segura|no sabria|i dont know|i don t know|not sure|dunno|no idea)\b/;
  var CHANGE_HEAD = /^ (?:(?:pero|but)\s+)?(?:(?:pedile|decile|tell it|ask it to|ask it)\s+)?(?:que\s+)?((?:cambia|cambie|cambiar|change|fix|arregla|arregle|corregi|corrige|corrija|modifica|modifique|agrega|agregue|saca|saque|quita|quite|pone|ponga|hace|haga|make|add|remove|use|usa|usa)\b.*)$/;
  // An option by its order: "la segunda", "the second one", "option two", "la última", "la de arriba" —
  // order words and fillers only, so the page's own "Which one: …" is never an answer.
  var ORD_MAP = { primera: 0, primero: 0, first: 0, "1": 0, uno: 0, one: 0, segunda: 1, segundo: 1, second: 1, "2": 1, dos: 1, two: 1,
    tercera: 2, tercero: 2, third: 2, "3": 2, tres: 2, three: 2, cuarta: 3, cuarto: 3, fourth: 3, "4": 3, cuatro: 3, four: 3,
    ultima: -1, ultimo: -1, last: -1 };
  var ORD_SOFT = { uno: 1, one: 1 }; // "the second one": here "one" names the option, it is not its order
  var ORD_FILL = "la el lo the de del opcion option numero number arriba por favor please quiero elijo".split(" ");
  function ordinalOf(words, n, count) {
    if (words.length > 4 || !words.every(function (w) { return ORD_MAP.hasOwnProperty(w) || ORD_FILL.indexOf(w) >= 0; })) return null;
    var picks = [];
    words.forEach(function (w) { if (ORD_MAP.hasOwnProperty(w) && !ORD_SOFT[w]) picks.push(ORD_MAP[w] < 0 ? count - 1 : ORD_MAP[w]); });
    if (!picks.length && / de arriba /.test(n)) picks.push(0);
    if (!picks.length && words.some(function (w) { return ORD_SOFT[w]; })) picks.push(0);
    var one = picks.filter(function (p, i) { return picks.indexOf(p) === i; });
    return one.length === 1 && one[0] < count ? one[0] : null;
  }
  var EMPTY = new Set();

  /**
   * What an utterance means for this card. Pure (the tests drive it). `exclude` = the words the page
   * itself says for this card (pageWords): none of them counts as a yes.
   */
  function intentOf(text, it, exclude) {
    var ex = exclude || EMPTY;
    var raw = String(text == null ? "" : text);
    var n = norm(raw);
    var words = n.trim().split(" ").filter(Boolean);
    if (!words.length) return { type: "unclear" };
    if (CLOSE_RE.test(n)) return { type: "close" };
    if (UNSURE_RE.test(n)) return { type: "unclear" };
    if (WAIT_RE.test(n)) return { type: "wait" };
    if (REPEAT_RE.test(n)) return { type: "repeat" };
    if (MORE_RE.test(n)) return { type: "more" };
    if (LATER_RE.test(n)) return { type: "later" };
    if (NEXT_RE.test(n)) return { type: "next" };
    // A question asked back is never a decision ("¿sí?" is "really?", not approval).
    if (/[?¿]/.test(raw)) return { type: "unclear" };
    var q = it && it.question;
    // An option, by its order or by its own words — and nothing else in the utterance (the page reads
    // the options and the question aloud: a sentence of its own must not match one).
    if (q && q.options.length && !q.yn) {
      var hit = ordinalOf(words, n, q.options.length);
      if (hit == null) {
        var optWords = new Set();
        q.options.forEach(function (o) { norm(o).trim().split(" ").forEach(function (w) { if (w) optWords.add(w); }); });
        var onlyOpt = words.every(function (w) { return optWords.has(w) || OPT_FILLER.indexOf(w) >= 0; });
        if (onlyOpt) {
          var scores = q.options.map(function (o) {
            var ow = norm(o).trim().split(" ").filter(function (w) { return w.length > 2; });
            if (!ow.length) return 0;
            return ow.filter(function (w) { return n.indexOf(" " + w + " ") >= 0; }).length / ow.length;
          });
          var best = -1, bi = -1, second = 0;
          scores.forEach(function (sc, i) { if (sc > best) { second = best; best = sc; bi = i; } else if (sc > second) second = sc; });
          if (best >= 0.6 && best - Math.max(0, second) >= 0.25) hit = bi;
        }
      }
      if (hit != null) return { type: "option", option: hit };
    }
    var ch = CHANGE_HEAD.exec(n);
    if (ch) return { type: "change", words: raw.replace(/^\s*(no|pero|but)[\s,.:;!]+/i, "").trim() };
    if (/^ (si|yes) pero /.test(n) || /^ pero /.test(n)) return { type: "change", words: raw.replace(/^\s*(s[ií]|yes)?[\s,]*(pero|but)[\s,.:;!]+/i, "").trim() };
    // "Decí …" is the page's own word ("decí cancelar", "decí veamos"): only "decile/respondele/…" is his.
    var free = /^ (decile|respondele|contestale|tell it|answer|respond) (que )?(.+)$/.exec(n);
    if (free) return { type: "free", words: raw.replace(/^\s*\S+\s+(que\s+)?/i, "").trim() };
    if (n === " no " || n === " nope " || n === " no gracias ") return { type: "no" };
    // "No, <something>": what follows is read back and asked about before it reaches the terminal —
    // "No te entendí" or "No queda nada" coming back through the speaker must not become a change.
    if (/^ no /.test(n) && words.length > 2) return { type: "nochange", words: raw.replace(/^\s*no[\s,.:;!]+/i, "").trim() };
    // Yes: short, made only of yes-words and fillers. A yes-word the page itself says for this card
    // does not count (it may be the speaker's own voice coming back).
    var phrases = STRONG_PHRASE.filter(function (ph) { return n.indexOf(ph) >= 0; });
    var phraseWords = new Set();
    phrases.forEach(function (ph) { ph.trim().split(" ").forEach(function (w) { phraseWords.add(w); }); });
    var strong = phrases.some(function (ph) { return ph.trim().split(" ").every(function (w) { return !ex.has(w); }); });
    var weak = false, pageWord = phrases.length > 0 && !strong, other = false;
    words.forEach(function (w) {
      if (STRONG_YES.indexOf(w) >= 0) { if (ex.has(w)) pageWord = true; else strong = true; }
      else if (WEAK_YES.indexOf(w) >= 0) { if (ex.has(w)) pageWord = true; else weak = true; }
      else if (!isFiller(w) && !phraseWords.has(w)) other = true;
    });
    if (other || words.length > 6 || words.some(function (w) { return NEG.indexOf(w) >= 0; })) return { type: "unclear" };
    if (strong) return { type: "yes", strength: "strong" };
    if (weak) return it && IRREVERSIBLE[it.kind] ? { type: "weak" } : { type: "yes", strength: "weak" };
    return { type: "unclear", why: pageWord ? "page-word" : null };
  }

  function readout(it) {
    var name = it.ws ? C.wsName(it.ws) + ". " : "";
    var head = name + it.verdict.replace(/[.!?]*$/, ".");
    var body = [], ask;
    if (it.kind === "question") {
      var q = it.question;
      if (q.note) body.push(t(assistant() + " sugiere: ", assistant() + " suggests: ") + q.note);
      if (q.yn) ask = t("¿Qué le contesto?", "What do I answer?");
      else if (q.options.length) ask = t("Opciones: ", "Options: ") + q.options.join(t(", o ", ", or ")) + ".";
      else ask = t("¿Qué le respondo?", "What should I answer?");
      return { head: (it.title ? it.title + ". " : "") + t("Pregunta: ", "It asks: ") + plain(q.text), body: body, ask: ask };
    }
    if (it.kind === "draft") {
      var d = it.draft, where = d.kind === "email" ? t("un mail", "an email") : t("un mensaje de Slack", "a Slack message");
      head = name + t("Borrador: ", "A draft: ") + where + (d.to || d.channel ? t(" para ", " to ") + (d.to || d.channel) : "") + ".";
      if (d.subject) body.push(t("Asunto: ", "Subject: ") + d.subject + ".");
      if (d.text) body.push(t("Dice así: ", "It reads: ") + d.text);
      ask = d.text ? t("¿La apruebo? Sigue como borrador; la mandás vos.", "Do you approve it? It stays a draft; you send it.") : t("No me llegó el texto completo, así que no puedo aprobarlo. Está en tus borradores.", "The full text did not come through, so I can't approve it. It's in your drafts.");
      return { head: head, body: body, ask: ask };
    }
    if (it.kind === "blocked") return { head: name + t("Se frenó: ", "It stopped: ") + it.verdict + ".", body: [], ask: t("¿Qué le digo? O decí después.", "What should I tell it? Or say later.") };
    var fails = (it.checks || []).filter(function (g) { return g.state === "fail"; }).map(function (g) { return g.name.toLowerCase(); });
    var pass = (it.checks || []).filter(function (g) { return g.state === "pass"; }).map(function (g) { return g.name.toLowerCase(); });
    if (fails.length) body.push(t("Ojo: el agente reporta un problema en ", "Careful: the agent reports a problem with ") + fails.join(t(" y ", " and ")) + ".");
    else if (pass.length) body.push(t("Según el agente: ", "The agent says: ") + pass.map(function (p) { return { tests: t("los tests pasan", "tests pass"), "nothing else broke": t("no se rompió nada más", "nothing else broke"), review: t("lo revisaron", "it was reviewed"), "checked by hand": t("lo chequeó a mano", "it was checked by hand"), evidence: t("hay evidencia", "there is evidence") }[p] || p; }).join(t(", ", ", ")) + ".");
    else body.push(t("No dejó pruebas.", "It filed no proof."));
    if (it.pairs && it.pairs.length) body.push(t("Tenés el antes y el después en pantalla.", "The before and after are on screen."));
    ask = { merge: t("¿Lo mergeo?", "Shall I merge?"), deploy: t("¿Lo despliego?", "Shall I deploy?"), "merge+deploy": t("¿Lo mergeo y despliego?", "Shall I merge and deploy?"), review: t("¿Lo doy por leído?", "Shall I mark it read?") }[it.kind];
    if (APPROVES[it.kind] && !it.live) ask = SAY.termEnded();
    return { head: head, body: body, ask: ask };
  }
  function reprompt(it) {
    if (it.kind === "question") { var q = it.question; return q.yn ? t("¿Qué le contesto? O decí después.", "What do I answer? Or say later.") : q.options.length ? t("¿Cuál: ", "Which one: ") + q.options.join(t(" o ", " or ")) + t("? O decí después.", "? Or say later.") : t("¿Qué le respondo? O decí después.", "What should I answer? Or say later."); }
    if (it.kind === "blocked") return t("¿Qué le digo? O decí después.", "What should I tell it? Or say later.");
    var verb = { merge: t("¿Lo mergeo", "Shall I merge"), deploy: t("¿Lo despliego", "Shall I deploy"), "merge+deploy": t("¿Lo mergeo y despliego", "Shall I merge and deploy"), review: t("¿Lo doy por leído", "Shall I mark it read"), draft: t("¿La apruebo", "Do you approve it") }[it.kind];
    return verb + t(", lo dejo para después, o qué cambio?", ", later, or what should change?");
  }
  /** Every line the deck may say for this card, in the current language — what pageWords is built from. */
  function deckLines(it) {
    var r = readout(it), out = [r.head, r.ask].concat(r.body, [reprompt(it)]);
    out = out.concat((it.proof || []), (it.changes || []));
    Object.keys(SAY).forEach(function (k) {
      var f = SAY[k];
      try {
        if (k === "answered") (it.question ? it.question.options : []).forEach(function (o) { out.push(f(o, it.question.yn)); });
        else if (k === "weak" || k === "done") out.push(f(it.kind) || "");
        else if (k === "hold" || k === "draftToday") { if (IRREVERSIBLE[it.kind] && (k === "hold" || it.draft)) out.push(f(it)); }
        else if (f.length === 0) out.push(f());
      } catch (e) {}
    });
    return out.filter(Boolean);
  }
  /** The words the page says for this card, in either language: none of them can be his yes. */
  var PW = new Map();
  function pageWords(it) {
    var k = it.key + "§" + it.rev;
    if (PW.has(k)) return PW.get(k);
    var set = new Set(), keep = C.lang;
    ["es", "en"].forEach(function (lang) {
      C.lang = function () { return lang; };
      try { deckLines(it).forEach(function (line) { norm(line).trim().split(" ").forEach(function (w) { if (w) set.add(w); }); }); } finally { C.lang = keep; }
    });
    if (PW.size > 50) PW.clear();
    PW.set(k, set);
    return set;
  }

  // A question to him for this card: when it has played to its end, his answer may start.
  function askNow(it, text) {
    var key = it.key;
    VA.askEndedAt = null;
    return C.voice.say(text, { tag: "card" }).then(function (ok) { if (ok && VA.key === key) VA.askEndedAt = nowMs(); return ok; });
  }
  function readCard(it) {
    if (!it || !C.voice.on) return;
    if (VA.hold && VA.hold.key !== it.key) cancelHold(true);
    C.voice.skip(false);
    var r = readout(it), key = it.key, rev = it.rev;
    VA = { key: key, rev: rev, verdict: false, read: false, askEndedAt: null, unclear: 0, awaiting: null, pending: null, weak: null, hold: null };
    var tag = "card";
    C.voice.say(r.head, { tag: tag }).then(function (ok) { if (VA.key === key && ok) VA.verdict = true; });
    var bodyDone = r.body.length ? C.voice.say(r.body.join(" "), { tag: tag }) : Promise.resolve(true);
    bodyDone.then(function (ok) { if (VA.key === key && VA.rev === rev && ok) VA.read = true; });
    if (r.ask) askNow(it, r.ask);
  }
  function speakThen(text, next) {
    return C.voice.say(text, { tag: "card" }).then(function () { if (next) next(); });
  }
  function afterDecision(msg) {
    if (msg == null) return; // it failed: run() already said why
    speakThen(msg, function () {
      if (!D.open) return;
      var nxt = current();
      // He may have spoken over the line, and the next card is already being read: once is enough.
      if (nxt) { if (VA.key !== nxt.key || VA.rev !== nxt.rev) readCard(nxt); }
      else C.voice.say(SAY.nothingLeft());
    });
  }

  // The voice twin of Undo: an irreversible yes is said out loud and held; "cancelar", "no", "pará",
  // anything that is not a yes, a barge-in, hanging up or leaving the card stops it.
  function holdThenRun(it, words, meta) {
    var key = it.key;
    var h = { key: key, timer: 0, cancelled: false, waited: 0 };
    VA.hold = h;
    // The on-screen Cancel lasts the whole window (the line, the wait, words still on their way).
    C.toast(SAY.hold(it), { label: t("Cancelar", "Cancel"), fn: function () { cancelHold(); }, ms: 60000 });
    // When the window closes while he is still talking (or his words are still being transcribed), it
    // waits for them: a "cancelar" said at the last second counts by when it was said, not when it landed.
    // Words still in flight after that wait mean nothing happens — never an action on an unheard reply.
    var fire = function () {
      if (VA.hold !== h || h.cancelled) return;
      var st = C.voice.state ? C.voice.state() : "";
      if (st === "hearing" || st === "transcribing") {
        if (h.waited >= HOLD_WAIT_MS) { cancelHold(); return; }
        h.waited += 300; h.timer = setTimeout(fire, 300); return;
      }
      VA.hold = null;
      // Still the card he heard? It may have been decided elsewhere, or changed (a new PR head, new
      // words) while the window was open: a yes to what he heard never covers something else.
      var still = Q.items.find(function (x) { return x.key === it.key; });
      if (!still || still.rev !== it.rev) {
        var why = still ? SAY.moved() : SAY.gone();
        C.toast(why);
        if (C.voice.on) C.voice.say(why, { tag: "card" }).then(function () { if (still && D.open && VA.key === it.key) readCard(still); });
        return;
      }
      run(still, "yes", null, null, false, meta).then(function (msg) { if (msg) C.toast(msg); afterDecision(msg); });
    };
    C.voice.say(SAY.hold(it), { tag: "card" }).then(function (ok) {
      if (VA.hold !== h || h.cancelled) return;
      if (!ok) { VA.hold = null; C.toast(SAY.cancelled()); return; } // never fully heard: nothing happens
      h.timer = setTimeout(fire, HOLD_MS);
    });
  }
  function cancelHold(silent) {
    var h = VA.hold;
    if (!h) return false;
    h.cancelled = true; clearTimeout(h.timer); VA.hold = null;
    C.toast(SAY.cancelled()); // replaces the toast whose Cancel button belonged to this hold
    if (!silent && C.voice.on) { C.voice.skip(false, "card"); C.voice.say(SAY.cancelled(), { tag: "card" }); }
    if (C.fx) C.fx.tap();
    return true;
  }

  /**
   * A transcript during a call. True when the deck took it (it never reaches Robert then).
   * meta (phone-voice.js): t0 = when he started speaking, overlap = page audio played during it,
   * echo = flagged by the echo guard, barge = he spoke over the page.
   */
  function voiceAnswer(text, meta) {
    if (!D.open || !C.voice.on) return false;
    meta = meta || {};
    var it = current();
    if (!it) return false;
    var i = intentOf(text, it, pageWords(it));
    // Inside the hold window anything that is not a yes stops the action.
    if (VA.hold) {
      if (i.type !== "yes" || i.strength !== "strong") cancelHold();
      return true;
    }
    // The card under the words must be the card that was read — else read the one on screen first.
    if (VA.key !== it.key || VA.rev !== it.rev) { readCard(it); return true; }
    var heard = { voice: true, words: text, how: "strong" };
    var COMMAND = { close: 1, wait: 1, repeat: 1, more: 1, next: 1 };
    if (!COMMAND[i.type]) {
      // Our own voice coming back: say nothing, decide nothing.
      if (meta.echo) return true;
      // He started before the question was over, or spoke over the page: decide nothing. While the
      // card is still being read, let it finish (its question comes at the end); once it is quiet,
      // read what he missed or ask again.
      if (VA.askEndedAt == null || meta.t0 == null || meta.t0 < VA.askEndedAt || meta.overlap) {
        if (C.voice.state && C.voice.state() === "speaking") return true;
        if (it.kind === "draft" && !VA.read) { speakThen(SAY.readFirst(), function () { if (VA.key === it.key) readCard(it); }); return true; }
        if (!VA.verdict) { readCard(it); return true; }
        C.voice.say(SAY.letMeFinish(), { tag: "card" });
        askNow(it, readout(it).ask || reprompt(it));
        return true;
      }
    }
    if (VA.awaiting === "confirm") {
      var p = VA.pending;
      if (i.type === "yes") { VA.awaiting = null; VA.pending = null; run(it, p.d, p.words, null, false, { voice: true, words: text, how: "answer" }).then(afterDecision); return true; }
      if (i.type === "later" || i.type === "no" || i.type === "close") { VA.awaiting = null; VA.pending = null; if (i.type === "close") { close(); return true; } C.voice.say(SAY.notSent(), { tag: "card" }); askNow(it, reprompt(it)); return true; }
      if (i.type !== "unclear" && i.type !== "repeat") { VA.awaiting = null; VA.pending = null; }
      else { askNow(it, SAY.sendThis(p.words)); return true; }
    }
    if (VA.awaiting === "words") {
      if (i.type === "later") { VA.awaiting = null; }
      else if (i.type === "close") { close(); return true; }
      else if (i.type !== "yes" && i.type !== "repeat" && plain(text).split(" ").length >= 2) {
        VA.awaiting = null;
        var dd = it.kind === "question" ? "yes" : "change";
        if (dd === "change" && it.kind !== "blocked") { run(it, "change", plain(text), null, false, { voice: true, words: text, how: "change" }).then(afterDecision); return true; }
        VA.awaiting = "confirm"; VA.pending = { d: dd, words: plain(text) };
        askNow(it, SAY.sendThis(plain(text)));
        return true;
      }
    }
    switch (i.type) {
      case "close": close(); return true;
      case "wait": C.voice.skip(false, "card"); return true;
      case "repeat": readCard(it); return true;
      case "next": if (D.idx < Q.items.length - 1) move(1); else C.voice.say(SAY.lastOne(), { tag: "card" }); return true;
      case "more": {
        var lines = (it.proof || []).concat(it.changes || []);
        C.voice.say(lines.length ? lines.join(". ") : SAY.nothingMore(), { tag: "card" }).then(function () { if (VA.key === it.key) askNow(it, reprompt(it)); });
        return true;
      }
      case "later": run(it, "later", null, null, false, { voice: true, words: text, how: "later" }).then(afterDecision); return true;
      case "option": run(it, "yes", null, i.option, false, { voice: true, words: text, how: "answer" }).then(afterDecision); return true;
      case "weak":
        // "ok", "bien", "listo"… on something that cannot be undone: asked once more, never acted on.
        VA.weak = text;
        askNow(it, SAY.weak(it.kind));
        return true;
      case "yes": {
        if (it.kind === "question") {
          var q = it.question, aff = q.yn ? 0 : q.options.findIndex(function (o) { return /^ (yes|si|ok|approve|approved|go|dale|keep) /.test(norm(o)) || norm(o).trim() === "yes"; });
          if (aff >= 0) { run(it, "yes", null, aff, false, { voice: true, words: text, how: "answer" }).then(afterDecision); return true; }
          askNow(it, reprompt(it)); return true;
        }
        if (it.kind === "blocked") { VA.awaiting = "words"; askNow(it, SAY.whatToTell()); return true; }
        if (it.kind === "draft" && !it.draft.text) { C.voice.say(SAY.noFullText(), { tag: "card" }); return true; }
        if (it.kind === "draft" && !VA.read) { speakThen(SAY.readFirst(), function () { if (VA.key === it.key) readCard(it); }); return true; }
        if (!VA.verdict) { readCard(it); return true; }
        if (APPROVES[it.kind] && !it.live) { C.voice.say(SAY.termEnded(), { tag: "card" }); return true; }
        if (IRREVERSIBLE[it.kind]) {
          if (VA.weak) { heard.words = VA.weak + " → " + text; heard.how = "confirmed"; }
          holdThenRun(it, null, heard);
          return true;
        }
        run(it, "yes", null, null, false, heard).then(afterDecision);
        return true;
      }
      case "change": if (i.words && plain(i.words).split(" ").length >= 2) { if (it.kind === "question" || it.kind === "blocked") { VA.awaiting = "confirm"; VA.pending = { d: it.kind === "question" ? "yes" : "change", words: i.words }; askNow(it, SAY.sendThis(i.words)); return true; } run(it, "change", i.words, null, false, { voice: true, words: text, how: "change" }).then(afterDecision); return true; }
        VA.awaiting = "words"; askNow(it, SAY.whatChange()); return true;
      case "no":
        // A yes/no question: "no" is its answer, as explicit as "sí". Anywhere else it means "not like
        // this" — ask what should change.
        if (it.kind === "question" && it.question.yn) { run(it, "yes", null, 1, false, { voice: true, words: text, how: "answer" }).then(afterDecision); return true; }
        VA.awaiting = "words"; askNow(it, it.kind === "blocked" ? SAY.whatToTell() : SAY.whatChange());
        return true;
      case "nochange":
        VA.awaiting = "confirm"; VA.pending = { d: it.kind === "question" ? "yes" : "change", words: i.words };
        askNow(it, SAY.sendThis(i.words));
        return true;
      case "free": if (it.kind === "question" || it.kind === "blocked") { VA.awaiting = "confirm"; VA.pending = { d: it.kind === "question" ? "yes" : "change", words: i.words }; askNow(it, SAY.sendThis(i.words)); return true; }
        run(it, "change", i.words, null, false, { voice: true, words: text, how: "change" }).then(afterDecision); return true;
      default:
        // A yes made only of words the page itself says for this card cannot be told from its echo.
        if (i.why === "page-word") { C.voice.say(SAY.tapInstead(), { tag: "card" }); return true; }
        VA.unclear++;
        if (VA.unclear <= 3) { C.voice.say(SAY.notCaught() + (VA.unclear >= 2 ? " " + SAY.toRobert() : ""), { tag: "card" }); askNow(it, reprompt(it)); }
        return true;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────
  function init(ctx) {
    C = ctx;
    var el = ctx.el;
    D.el = el;
    el.innerHTML = '<div class="dk-head"><button type="button" class="dk-x" aria-label="Close">' + ICON.x + '</button><span class="dk-pos"></span><span class="dk-nav"><button type="button" data-nav="-1" aria-label="Previous">' + ICON.back + '</button><button type="button" data-nav="1" aria-label="Next">' + ICON.chev + "</button></span>" +
      '<span class="dk-call" hidden><i></i><b></b><button type="button" class="dk-hang" aria-label="End the conversation"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="3"/></svg></button></span><span class="dk-dots"></span></div>' +
      '<div class="dk-track"></div><div class="dk-empty" hidden><b>All clear.</b><span>Nothing is waiting for you.</span></div><div class="dk-bar"></div>';
    D.track = el.querySelector(".dk-track"); D.bar = el.querySelector(".dk-bar");
    el.querySelector(".dk-x").onclick = function () { if (C.fx) C.fx.tap(); close(); };
    el.querySelector(".dk-hang").onclick = function () { if (C.fx) C.fx.tap(); C.voice.stop(); };
    el.querySelector(".dk-nav").onclick = function (e) { var b = e.target.closest("[data-nav]"); if (b) move(Number(b.dataset.nav)); };
    var st = 0;
    D.track.addEventListener("scroll", function () { clearTimeout(st); st = setTimeout(onScroll, 60); }, { passive: true });
    wireSwipe(D.track);
    D.bar.addEventListener("click", function (e) { var b = e.target.closest("[data-d]"); if (b && !b.disabled) onBar(b.dataset.d); });
    D.track.addEventListener("click", function (e) {
      var it = current(); if (!it) return;
      // Only the card on screen answers. A button on a neighbour (reached with Tab, or clicked while
      // the track is still sliding) must never decide the current card with its own option.
      var card = e.target.closest(".qcard");
      if (!card || card.dataset.key !== it.key || !settled()) return;
      var full = e.target.closest("[data-full]"); if (full) { if (C.fx) C.fx.tap(); return openViewer(it, full.dataset.full); }
      var opt = e.target.closest("[data-opt]"); if (opt) { if (C.fx) C.fx.tap(); return act(it, "yes", null, Number(opt.dataset.opt)); }
      var term = e.target.closest("[data-term]"); if (term) { close(); return C.openTerminal(term.dataset.term); }
      var ck = e.target.closest("[data-ck]");
      if (ck) { var raw = ck.parentElement.querySelector('[data-ckraw="' + ck.dataset.ck + '"]'); if (raw) { raw.hidden = !raw.hidden; ck.classList.toggle("open", !raw.hidden); } return; }
      var sg = e.target.closest(".ba"); if (sg && !e.target.closest(".ba-full")) return;
    });
    addEventListener("resize", function () { if (D.open) D.track.scrollLeft = D.idx * D.track.clientWidth; });
    // Keys: ←/→ move between cards, Esc closes the viewer, then the deck. NO key decides — not Enter,
    // not Space, not a letter: a yes is a click on its button (with its Undo) or a spoken yes (with its
    // hold). A key that something above already took (a sheet closing on Esc), a key typed into a
    // field, and any chord (⌘←) are not ours.
    document.addEventListener("keydown", function (e) {
      if (!D.open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      var tg = e.target, typing = !!(tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || "") || tg.isContentEditable));
      if (e.key === "Escape") { e.preventDefault(); if (PV) PV.close(); else close(); return; }
      if (typing || PV) return;
      if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
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
    _yesFollowUp: yesFollowUp,
    init: init, load: load, loadSoon: loadSoon, open: open, close: close, onEvent: onEvent, TOPICS: TOPICS,
    items: function () { return Q.items.slice(); }, loaded: function () { return Q.loaded; },
    isOpen: function () { return D.open; }, current: current, readCurrent: function () { readCard(current()); },
    voiceAnswer: voiceAnswer, cancelHold: function (silent) { return cancelHold(!!silent); }, onBarge: function () { return cancelHold(); }, holding: function () { return !!VA.hold; }, forSession: function (sid) { var it = Q.items.find(function (x) { return x.sid === sid; }); return it ? it.key : null; },
    has: function (key) { return Q.items.some(function (x) { return x.key === key; }); },
    viewerOpen: function () { return !!PV; }, closeViewer: function (fromHistory) { if (PV) PV.close(!!fromHistory); },
    KIND_WORD: KIND_WORD,
    // Pure helpers, for the tests (src/phone-deck.test.ts).
    _t: { intentOf: intentOf, groupProof: groupProof, lineFails: lineFails, pairShots: pairShots, firstSentence: firstSentence, handoffItem: handoffItem, questionItem: questionItem, draftItem: draftItem, blockedItem: blockedItem, readout: readout, decide: decide, setCtx: function (c) { C = c; }, APPROVES: APPROVES, hidden: hidden, record: record, draftHash: draftHash, draftCanon: draftCanon, ledgerItem: ledgerItem,
      SAY: SAY, STRONG_YES: STRONG_YES, WEAK_YES: WEAK_YES, STRONG_PHRASE: STRONG_PHRASE, IRREVERSIBLE: IRREVERSIBLE, pageWords: pageWords, deckLines: deckLines, reprompt: reprompt, voiceAnswer: voiceAnswer,
      settled: settled, swipeStartOk: swipeStartOk, swipeIntent: swipeIntent, swipeTarget: swipeTarget, wireSwipe: wireSwipe, SWIPE: SWIPE,
      setHold: function (ms, wait) { HOLD_MS = ms; if (wait != null) HOLD_WAIT_MS = wait; }, va: function () { return VA; }, act: act,
      // Put items on the deck without a page (the vm tests): open, first card current.
      mount: function (items) { Q.items = items.slice(); Q.loaded = true; D.open = true; D.idx = 0; D.dest = null; D.cool = 0; } },
  };
})(typeof window !== "undefined" ? window : globalThis);

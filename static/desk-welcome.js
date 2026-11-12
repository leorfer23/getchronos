/* First run on the Desk: name the assistant, check the agents, make the first project, the phone,
 * and meet the assistant — one card, one thing at a time, every step skippable, under a minute.
 *
 * It shows once: GET /api/onboarding says not done AND there is no project yet. Finishing it, or
 * "Skip setup", says done (PUT /api/onboarding) and it never comes back. After it — whenever nothing is
 * running and the conversation is empty — the stage says one line on what to do next instead of
 * nothing (the empty hint, bottom of this file).
 *
 * Only doors that already exist:
 *   name     PUT /api/assistant (src/assistant-routes.ts), then AssistantName.set() repaints the page.
 *   agents   GET /api/setup/status, POST /api/setup/smoke|install|login/:id (src/setup-routes.ts) and
 *            GET /api/setup/parity + POST /api/setup/parity/fix/:id — each one feature-detected: a 404
 *            means "this daemon can't check from here yet", never an error on screen.
 *   project  GET /api/onboarding/folder (what the folder is: ~/ expanded, git or not), then the
 *            ordinary POST /api/workspaces (+ POST /api/workspaces/:id/repos for a git checkout; a plain
 *            folder becomes the project's landing dir, `default_dir`, where its terminals open).
 *   phone    window.ChronosPhone.open() when the phone dialog is on this page, else the guide page
 *            (/guide/phone); with neither, the optional step is skipped rather than a dead end.
 *   meet     a canned hello (no model wait), and chips that send REAL messages through the page's
 *            own composer (queueAsk) — so the first answer is the assistant's own.
 * The page's globals (queueAsk, chatOpen, load, S, LOCK, booted) are only ever used when present.
 */
(function (root) {
  "use strict";
  var STEPS = ["name", "agents", "project", "phone", "meet"];
  // The two most people already pay for; the rest of the CLIs fold away unless installed or their app is here.
  var FIRST = { claude: true, codex: true };
  var APP = { claude: ["Claude", "Claude Code"], codex: ["ChatGPT", "Codex"], "cursor-agent": ["Cursor", "the Cursor CLI"] };

  // ── pure: lifted out and run by src/desk-welcome.test.ts ─────────────────────────────────────────
  function shouldShow(done, projects) { return done === false && projects === 0; }

  /** A workspace slug from a project name: lower-case words joined by "-", accents dropped. */
  function slugify(s) {
    var t = String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
    return t || "project";
  }

  /** The folder's last part, as a starting name ("~/code/my-app/" → "my-app"). */
  function baseName(p) {
    var parts = String(p || "").trim().replace(/\/+$/, "").split("/");
    var b = parts[parts.length - 1] || "";
    return b === "~" ? "" : b;
  }

  /** ready · signin · install · missing — what one CLI row of /setup/status is, for this step. */
  function cliState(c) {
    if (!c) return "missing";
    if (c.installed && c.loggedIn === false) return "signin";
    if (c.installed) return "ready"; // loggedIn null = can't tell: "Test" says for sure
    return c.can_install ? "install" : "missing";
  }

  function cliRows(clis) {
    var shown = [], more = [], ready = [];
    (clis || []).forEach(function (c) {
      if (cliState(c) === "ready") ready.push(c);
      (FIRST[c.id] || c.installed || c.app ? shown : more).push(c);
    });
    return { shown: shown, more: more, ready: ready };
  }

  /** The one line under a CLI's name. */
  function cliLine(c) {
    var st = cliState(c);
    if (st === "ready") return [c.version, c.authDetail].filter(Boolean).join(" · ") || "Installed";
    if (st === "signin") return "Installed — not signed in yet";
    var app = APP[c.id];
    if (c.app && app) return "You use " + app[0] + " — install " + app[1] + ", it runs on the same subscription";
    return st === "install" ? "Not installed" : "Not installed — paste this in a terminal:";
  }

  /** The backend a first project should open on: Claude Code when it works, else the first CLI that does. */
  function preferredBackend(clis) {
    var ready = cliRows(clis).ready;
    var c = ready.filter(function (x) { return x.id === "claude"; })[0] || ready[0];
    return c && c.backend ? c.backend : null;
  }

  /**
   * GET /api/setup/parity (src/parity.ts — names only, never a config value) → what the agents step says:
   * { count, fix: [ids], subs } or null (nothing to say, or nothing the Desk can do about it).
   * count = the person's own MCP servers the default profile's agents lack (Claude Code and Codex) plus
   * Claude Desktop servers not in Claude Code yet. `fix` = what "Bring them over" applies, in order: the
   * default profile's own fix (agents switch to the person's own setup — else their copy gets the
   * servers), then the Desktop import. Never a client profile's copy: those are separate on purpose.
   */
  function parityLine(p) {
    if (!p || typeof p.ok !== "boolean" || !p.claude || !Array.isArray(p.fixes)) return null;
    var dflt = function (list) { return (list || []).filter(function (x) { return x && x.default; })[0] || null; };
    var def = dflt(p.claude.profiles), cdef = dflt(p.codex && p.codex.profiles);
    var gap = function (x) { return x && x.mode !== "own" && Array.isArray(x.missing) ? x.missing.length : 0; };
    var importable = (p.claude.desktop && p.claude.desktop.importable) || [];
    var ids = p.fixes.map(function (f) { return f && f.id; });
    var fix = [];
    var own = ids.indexOf("claude-own-home") >= 0 ? "claude-own-home" : ids.indexOf("claude-bring-over:claude") >= 0 ? "claude-bring-over:claude" : null;
    if (own) fix.push(own);
    if (ids.indexOf("claude-desktop-import") >= 0) fix.push("claude-desktop-import");
    var subs = cdef ? "Claude / ChatGPT" : "Claude";
    var count = gap(def) + gap(cdef) + importable.length;
    if (p.ok && !count) return { count: 0, fix: [], subs: subs };
    return fix.length ? { count: count, fix: fix, subs: subs } : null;
  }

  /** A failed request, in words a person can act on. */
  function plainError(status, json, text) {
    var e = String((json && json.error) || (status >= 400 && text && text.length < 200 ? text : "") || "").replace(/^invalid request body — /, "");
    var m;
    if (status === 0) return "Couldn't reach Chronos — is the daemon still running?";
    if (/slug already exists/.test(e)) return "There's already a project with that name — pick another.";
    if ((m = /config_dir already used by workspace "([^"]+)"/.exec(e))) return "Project " + m[1] + " already uses this Claude account.";
    if (/path exists but is not a git repository/.test(e)) return "That folder isn't a git repository.";
    if (/could not detect default_branch/.test(e)) return "That git repo has no branch yet — make a first commit and try again.";
    if (status === 401 || status === 403) return e && !/admin token/i.test(e) ? e : "This browser isn't signed in to Chronos as you.";
    if (!e) return status >= 500 ? "Chronos hit an error — its log says why." : "That didn't work (" + status + ").";
    return e.charAt(0).toUpperCase() + e.slice(1);
  }

  /** What the assistant says first — instant, no model behind it. Four short lines. */
  function intro(name) {
    return [
      "Hi, I'm " + name + ".",
      "Tell me what you want done — I open an agent for it, keep it moving, and tell you when something needs you.",
      "You decide what ships: merges and deploys wait for your yes.",
      "Talk to me here, out loud with 🎙, or from your phone.",
    ];
  }

  /** The chips under the hello. `say` goes into the conversation as if typed; `href` opens a page. */
  function chips(slug) {
    return [
      { label: "What can you do?", say: "What can you do?" },
      { label: "Why use this instead of a terminal?", say: "Why use this instead of a terminal?" },
      { label: "Start my first task", say: slug ? "Start my first task in #" + slug : "Start my first task" },
      { label: "Show me the guide", href: "/guide" },
    ];
  }

  /** "Ada  O’Neil " → "Ada O'Neil": the server's own cleaning (settings.ts cleanAssistantName). */
  function cleanName(s) {
    return String(s || "").normalize("NFC").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\u00a0/g, " ").replace(/ {2,}/g, " ").trim();
  }

  var pure = { STEPS: STEPS, shouldShow: shouldShow, slugify: slugify, baseName: baseName, cliState: cliState, cliRows: cliRows,
    cliLine: cliLine, preferredBackend: preferredBackend, parityLine: parityLine, plainError: plainError, intro: intro, chips: chips,
    cleanName: cleanName };

  if (!root.document || !root.fetch) { root.DeskWelcome = pure; return; }

  // ── the page ─────────────────────────────────────────────────────────────────────────────────────
  var doc = root.document;
  var AN = root.AssistantName || { get: function () { return "Robert"; }, set: function () {}, valid: function () { return true; } };
  // The Desk's own top-level names (desk.html's page script runs first; `typeof` is safe when one is missing).
  var P = function () {
    return {
      queueAsk: typeof queueAsk === "function" ? queueAsk : null,
      chatOpen: typeof chatOpen === "function" ? chatOpen : null,
      chatIsOpen: typeof chatIsOpen === "function" ? chatIsOpen : null,
      load: typeof load === "function" ? load : null,
      setMode: typeof setMode === "function" ? setMode : null,
      S: typeof S !== "undefined" ? S : null,
      DW: typeof DW !== "undefined" ? DW : null,
      LOCK: typeof LOCK !== "undefined" ? LOCK : null,
      booted: typeof booted !== "undefined" ? booted : null,
    };
  };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };

  function token() {
    try { return root.__MC_TOKEN__ || root.localStorage.getItem("mc-token"); } catch (e) { return root.__MC_TOKEN__ || null; }
  }
  /** Never throws: { status, ok, json, text } — status 0 when the daemon could not be reached. */
  function call(method, path, body) {
    var h = { "x-mc-admin": token() || "" };
    if (body !== undefined) h["content-type"] = "application/json";
    return root.fetch("/api" + path, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) {
        return r.text().then(function (t) { var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {} return { status: r.status, ok: r.ok, json: j, text: t }; });
      })
      .catch(function (e) { return { status: 0, ok: false, json: null, text: String((e && e.message) || e) }; });
  }

  var W = {
    dlg: null, step: 0, open: false, done: false,
    nameDraft: null, msg: "", msgKind: "",
    status: null, statusAt: 0, parity: null, more: false, busy: {}, result: {},
    folder: "", pname: "", project: null, creating: false,
    phoneOpened: false, phoneGuide: null,
  };

  var CSS = [
    "#dlg-welcome { width:min(540px, 94vw); }",
    "#dlg-welcome .dw-in { padding:20px 24px 18px; display:flex; flex-direction:column; gap:12px; }",
    "#dlg-welcome .dw-top { display:flex; align-items:center; justify-content:space-between; min-height:22px; }",
    "#dlg-welcome .dw-dots { display:flex; gap:6px; }",
    "#dlg-welcome .dw-dots i { width:22px; height:4px; border-radius:2px; background:var(--line); }",
    "#dlg-welcome .dw-dots i.on { background:var(--accent); }",
    "#dlg-welcome .dw-skipall { border:0; background:none; color:var(--faint); font-size:13.5px; padding:2px 4px; cursor:pointer; }",
    "#dlg-welcome .dw-skipall:hover { color:var(--muted); }",
    "#dlg-welcome h2 { margin:4px 0 0; font-size:22px; line-height:1.25; letter-spacing:-.01em; }",
    "#dlg-welcome .dw-sub { margin:-6px 0 2px; color:var(--muted); font-size:15px; line-height:1.45; }",
    "#dlg-welcome label.dw-f { display:flex; flex-direction:column; gap:5px; font-size:12.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; font-weight:600; }",
    "#dlg-welcome input.dw-i { width:100%; padding:10px 12px; border-radius:9px; border:1px solid var(--line); background:var(--bg); color:var(--ink); font:inherit; font-size:17px; text-transform:none; letter-spacing:0; font-weight:500; }",
    "#dlg-welcome input.dw-i:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }",
    "#dlg-welcome .dw-msg { margin:0; min-height:1.45em; font-size:14px; line-height:1.45; color:var(--muted); }",
    "#dlg-welcome .dw-msg.err { color:var(--danger); }",
    "#dlg-welcome .dw-msg.ok { color:var(--ok); }",
    "#dlg-welcome .dw-foot { display:flex; gap:8px; justify-content:flex-end; align-items:center; }",
    "#dlg-welcome .dw-foot .left { margin-right:auto; }",
    "#dlg-welcome .btn:disabled { opacity:.45; cursor:default; }",
    "#dlg-welcome button:focus-visible, #dlg-welcome a:focus-visible { outline:3px solid var(--accent-soft); outline-offset:1px; }",
    "#dlg-welcome .dw-clis { display:flex; flex-direction:column; border:1px solid var(--line); border-radius:12px; overflow:hidden; }",
    "#dlg-welcome .dw-cli { display:grid; grid-template-columns:18px minmax(0,1fr) auto; column-gap:10px; row-gap:1px; align-items:center; padding:10px 12px; border-top:1px solid var(--line); }",
    "#dlg-welcome .dw-cli:first-child { border-top:0; }",
    "#dlg-welcome .dw-cli .ic { grid-row:1 / span 2; font-weight:700; text-align:center; color:var(--faint); }",
    "#dlg-welcome .dw-cli.ready .ic { color:var(--ok); }",
    "#dlg-welcome .dw-cli .nm { font-weight:600; font-size:15.5px; }",
    "#dlg-welcome .dw-cli .sub { grid-column:2; font-size:13.5px; color:var(--muted); line-height:1.4; overflow-wrap:anywhere; }",
    "#dlg-welcome .dw-cli .sub.ok { color:var(--ok); }",
    "#dlg-welcome .dw-cli .sub.err { color:var(--danger); }",
    "#dlg-welcome .dw-cli .act { grid-column:3; grid-row:1 / span 2; }",
    "#dlg-welcome .dw-cli .btn { font-size:14px; padding:5px 12px; white-space:nowrap; }",
    "#dlg-welcome .dw-cli code { display:inline-block; margin-top:3px; font:12.5px ui-monospace,\"SF Mono\",Menlo,monospace; background:var(--surface-2); border-radius:6px; padding:2px 6px; color:var(--ink); }",
    "#dlg-welcome .dw-more { border:0; border-top:1px solid var(--line); background:none; color:var(--muted); font:inherit; font-size:13.5px; padding:9px 12px; text-align:left; cursor:pointer; }",
    "#dlg-welcome .dw-more:hover { color:var(--ink); }",
    "#dlg-welcome .dw-line { margin:0; font-size:14px; color:var(--muted); }",
    "#dlg-welcome .dw-line.ok { color:var(--ok); }",
    "#dlg-welcome .dw-link { border:0; background:none; padding:0; font:inherit; color:var(--accent); font-weight:600; cursor:pointer; }",
    "#dlg-welcome a.dw-link { text-decoration:none; }",
    "#dlg-welcome .dw-link:hover { text-decoration:underline; }",
    "#dlg-welcome .dw-bub { background:var(--surface-2); border:1px solid var(--line); border-radius:14px; border-bottom-left-radius:4px; padding:12px 15px; font-size:16px; line-height:1.5; }",
    "#dlg-welcome .dw-bub p { margin:0 0 6px; } #dlg-welcome .dw-bub p:last-child { margin:0; }",
    ".dw-chips { display:flex; flex-wrap:wrap; gap:8px; }",
    ".dw-chips button { border:1px solid var(--line); background:var(--surface); color:var(--ink); border-radius:999px; padding:6px 14px; font:inherit; font-size:14.5px; font-weight:600; cursor:pointer; }",
    ".dw-chips button:hover { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }",
    ".dw-empty { margin:auto; max-width:440px; padding:24px 12px; display:flex; flex-direction:column; align-items:center; gap:10px; text-align:center; color:var(--muted); font-size:15.5px; line-height:1.5; }",
    ".dw-empty b { color:var(--ink); font-size:18px; font-weight:650; }",
    ".dw-empty .dw-chips { justify-content:center; margin-top:4px; }",
  ].join("\n");

  // ── steps ────────────────────────────────────────────────────────────────────────────────────────
  // Each view: { title, sub, body, primary: { label, disabled? }, left?: [label, act], skip?: bool }.
  var VIEWS = {
    name: function () {
      var v = W.nameDraft == null ? AN.get() : W.nameDraft;
      return {
        title: "Name your assistant",
        sub: "It runs your agents and tells you when something needs you. You can rename it later in ⚙ Settings.",
        body: '<input class="dw-i" id="dw-name" type="text" maxlength="24" autocomplete="off" spellcheck="false" aria-label="Your assistant\'s name" value="' + esc(v) + '">',
        primary: { label: "Continue", disabled: !AN.valid(cleanName(v)) },
      };
    },
    agents: function () {
      var body;
      if (!W.status) body = '<p class="dw-line">Checking your agents…</p>';
      else if (W.status.unavailable) body = '<p class="dw-line">Can\'t check your agents from here yet — the Desk will say if one needs signing in.</p>';
      else {
        var rows = cliRows(W.status.clis);
        body = '<div class="dw-clis">' + rows.shown.map(cliRow).join("") +
          (rows.more.length ? (W.more ? rows.more.map(cliRow).join("") : '<button type="button" class="dw-more" data-act="more">More agents (' + rows.more.length + ") ▸</button>") : "") +
          "</div>" + parityHtml();
      }
      var ready = W.status && !W.status.unavailable ? cliRows(W.status.clis).ready.length : 0;
      return {
        title: "Your agents",
        sub: "Chronos drives the AI coding tools you already have. One that works is enough to start.",
        body: body,
        primary: { label: "Continue", disabled: !!W.status && !W.status.unavailable && !ready },
        left: W.status && !W.status.unavailable ? ["Re-check", "recheck"] : null,
        skip: !!W.status && !W.status.unavailable && !ready,
      };
    },
    project: function () {
      if (W.project) {
        return {
          title: "Your first project",
          sub: "A folder your agents work in — usually a git repo.",
          body: '<p class="dw-line ok">✓ <b>' + esc(W.project.name) + "</b> is ready — " + esc(W.project.note) + "</p>",
          primary: { label: "Continue" },
        };
      }
      return {
        title: "Your first project",
        sub: "A folder your agents work in — usually a git repo.",
        body: '<label class="dw-f">Folder<input class="dw-i" id="dw-folder" type="text" autocomplete="off" spellcheck="false" placeholder="~/code/my-app" value="' + esc(W.folder) + '"></label>' +
          '<label class="dw-f">Name<input class="dw-i" id="dw-pname" type="text" autocomplete="off" spellcheck="false" maxlength="60" placeholder="' + esc(baseName(W.folder) || "my-app") + '" value="' + esc(W.pname) + '"></label>',
        primary: { label: W.creating ? "Creating…" : "Create project", disabled: W.creating || !W.folder.trim() },
        skip: true,
      };
    },
    phone: function () {
      var can = phoneDialog();
      return {
        title: "On your phone",
        sub: "Talk to " + AN.get() + " from anywhere and answer what needs you. Optional — about a minute.",
        body: can ? "" : '<p class="dw-line"><a class="dw-link" href="/guide/phone" target="_blank" rel="noopener">How to set it up →</a></p>',
        primary: { label: can && !W.phoneOpened ? "Set up phone" : "Continue" },
        skip: can && !W.phoneOpened,
        skipLabel: "Not now",
      };
    },
    meet: function () {
      var lines = intro(AN.get());
      return {
        title: "Meet " + AN.get(),
        sub: "",
        body: '<div class="dw-bub">' + lines.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("") + "</div>" +
          '<div class="dw-chips">' + chips(W.project && W.project.slug).map(function (c, i) { return '<button type="button" data-chip="' + i + '">' + esc(c.label) + "</button>"; }).join("") + "</div>",
        primary: { label: "Done" },
      };
    },
  };

  function cliRow(c) {
    var st = cliState(c), busy = W.busy[c.id], res = W.result[c.id];
    var sub = cliLine(c), subCls = "sub";
    var cmd = st === "missing" ? '<br><code>' + esc(c.install || "") + "</code>" : "";
    if (busy === "test") sub = "Asking it to reply…";
    if (busy === "install") sub = "Installing " + c.label + "…";
    if (busy === "signin") sub = "Finish signing in in your browser…";
    if (!busy && res) { sub = res.text; subCls += res.ok ? " ok" : " err"; cmd = res.cmd ? '<br><code>' + esc(res.cmd) + "</code>" : ""; }
    var act = "";
    var b = function (label, a, primary) { return '<button type="button" class="btn' + (primary ? " primary" : "") + '" data-act="' + a + '" data-id="' + esc(c.id) + '"' + (busy ? " disabled" : "") + ">" + esc(label) + "</button>"; };
    if (st === "ready") act = b(busy === "test" ? "Testing…" : "Test", "test");
    else if (st === "signin") act = b(busy === "signin" ? "Waiting…" : "Sign in", "signin", true);
    else if (st === "install") act = b(busy === "install" ? "Installing…" : "Install", "install", !!c.app);
    else act = c.install ? b("Copy", "copy") : "";
    return '<div class="dw-cli ' + st + '"><span class="ic">' + (st === "ready" ? "✓" : "–") + '</span><span class="nm">' + esc(c.label || c.id) + "</span>" +
      '<span class="act">' + act + "</span>" + '<span class="' + subCls + '">' + esc(sub) + cmd + "</span></div>";
  }

  function parityHtml() {
    var p = parityLine(W.parity);
    if (!p) return "";
    if (W.busy.parity) return '<p class="dw-line">Bringing your tools over…</p>';
    if (!p.fix.length) return '<p class="dw-line ok">Same tools as your own ' + esc(p.subs) + " ✓</p>";
    var link = '<button type="button" class="dw-link" data-act="parity">' + (p.count ? "Bring them over" : "Give them yours") + "</button>";
    return '<p class="dw-line">' + (p.count
      ? p.count + " of your tools " + (p.count === 1 ? "isn't" : "aren't") + " available to agents yet — "
      : "Your agents run on a separate copy of your Claude setup — ") + link + "</p>";
  }

  // ── render ───────────────────────────────────────────────────────────────────────────────────────
  function render() {
    var name = STEPS[W.step];
    var v = VIEWS[name]();
    var dots = STEPS.map(function (_s, i) { return "<i" + (i <= W.step ? ' class="on"' : "") + "></i>"; }).join("");
    var foot = (v.left ? '<button type="button" class="btn ghost left" data-act="' + v.left[1] + '">' + esc(v.left[0]) + "</button>" : "") +
      (v.skip ? '<button type="button" class="btn ghost" data-act="skip">' + esc(v.skipLabel || "Skip") + "</button>" : "") +
      '<button type="submit" class="btn primary" data-act="next"' + (v.primary.disabled ? " disabled" : "") + ">" + esc(v.primary.label) + "</button>";
    W.dlg.querySelector(".dw-in").innerHTML =
      '<div class="dw-top"><span class="dw-dots" aria-label="Step ' + (W.step + 1) + " of " + STEPS.length + '">' + dots + "</span>" +
      '<button type="button" class="dw-skipall" data-act="skipall">Skip setup</button></div>' +
      '<h2 id="dw-t">' + esc(v.title) + "</h2>" + (v.sub ? '<p class="dw-sub">' + esc(v.sub) + "</p>" : "") +
      v.body + (W.msg || name === "name" ? '<p class="dw-msg ' + W.msgKind + '" role="status">' + esc(W.msg) + "</p>" : "") +
      '<div class="dw-foot">' + foot + "</div>";
    var f = W.dlg.querySelector("#dw-name, #dw-folder") || W.dlg.querySelector('[data-act="next"]:not([disabled])');
    if (f && doc.activeElement !== f) {
      f.focus();
      if (f.id === "dw-name") f.select();
    }
  }
  function say(msg, kind) { W.msg = msg || ""; W.msgKind = kind || ""; }
  function go(step) {
    // The phone step is optional: with neither the phone dialog on this page nor its guide page to
    // point at, it would be a dead end — straight on to meeting the assistant.
    if (STEPS[step] === "phone" && !phoneDialog() && W.phoneGuide === false) step++;
    W.step = step; say(""); render();
    if (STEPS[step] === "agents" && !W.status) loadStatus(false);
    if (STEPS[step] === "meet") markDone();
  }
  function phoneDialog() { return !!(root.ChronosPhone && typeof root.ChronosPhone.open === "function"); }
  function next() { if (W.step < STEPS.length - 1) go(W.step + 1); else finish(); }

  // ── step actions ─────────────────────────────────────────────────────────────────────────────────
  function saveName() {
    var v = cleanName(W.nameDraft == null ? AN.get() : W.nameDraft);
    if (!AN.valid(v)) { say("Use up to 24 letters, digits, spaces or . - '", "err"); return render(); }
    if (v === AN.get()) return next();
    call("PUT", "/assistant", { name: v }).then(function (r) {
      if (!r.ok) { say(plainError(r.status, r.json, r.text), "err"); return render(); }
      AN.set(r.json.name);
      W.nameDraft = null;
      next();
    });
  }

  function loadStatus(fresh) {
    W.statusAt = Date.now();
    return Promise.all([call("GET", "/setup/status" + (fresh ? "?fresh=1" : "")), call("GET", "/setup/parity")]).then(function (rs) {
      var s = rs[0], p = rs[1];
      W.status = s.ok && s.json && Array.isArray(s.json.clis) && s.json.clis.length ? s.json : { unavailable: true };
      W.parity = p.ok ? p.json : null;
      if (W.open && STEPS[W.step] === "agents") render();
    });
  }

  function cliAct(act, id) {
    var c = (W.status && W.status.clis || []).filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (act === "copy") {
      return copyText(c.install).then(function (ok) {
        W.result[id] = { ok: true, text: ok ? "Copied — paste it in a terminal, then Re-check" : "Paste this in a terminal, then Re-check:", cmd: c.install };
        render();
      });
    }
    var path = { test: "/setup/smoke/", install: "/setup/install/", signin: "/setup/login/" }[act];
    W.busy[id] = act; delete W.result[id]; render();
    call("POST", path + encodeURIComponent(id)).then(function (r) {
      delete W.busy[id];
      var j = r.json || {};
      if (act === "test") {
        W.result[id] = r.ok && j.ok
          ? { ok: true, text: "Works — answered in " + (Math.round((Number(j.ms) || 0) / 100) / 10) + " s" }
          : { ok: false, text: "✗ " + (j.error || plainError(r.status, r.json, r.text)), cmd: c.try || null };
        return render();
      }
      if (r.ok && j.ok) { delete W.result[id]; return loadStatus(true); }
      var why = act === "install" ? lastLine(j.log_tail) || plainError(r.status, r.json, r.text) : j.message || plainError(r.status, r.json, r.text);
      W.result[id] = { ok: false, text: "✗ " + why, cmd: act === "install" ? c.install : act === "signin" && !/run in a terminal/.test(why) ? c.login : null };
      render();
    });
  }
  /** The clipboard API where the page may use it, else the old copy command; false when neither worked. */
  function copyText(t) {
    var legacy = function () {
      var ta = doc.createElement("textarea"); // inside the dialog: outside a modal, nothing can take focus
      ta.value = t; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      (W.dlg || doc.body).appendChild(ta); ta.select();
      var ok = false;
      try { ok = doc.execCommand("copy"); } catch (e) {}
      ta.remove();
      return ok;
    };
    try {
      if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
        return root.navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacy(); });
      }
    } catch (e) {}
    return Promise.resolve(legacy());
  }
  function lastLine(t) { var l = String(t || "").trim().split("\n").filter(Boolean); return l.length ? l[l.length - 1].slice(0, 160) : ""; }

  /** One fix after the other (the Desktop import lands where the first one pointed the agents); each answer carries the new report. */
  function bringTools() {
    var p = parityLine(W.parity);
    if (!p || !p.fix.length) return;
    W.busy.parity = true; render();
    var failed = null, signIn = [];
    p.fix.reduce(function (chain, id) {
      return chain.then(function () {
        if (failed) return;
        return call("POST", "/setup/parity/fix/" + encodeURIComponent(id)).then(function (r) {
          if (r.json && r.json.report) W.parity = r.json.report;
          if (r.json && r.json.result && Array.isArray(r.json.result.signIn)) signIn = signIn.concat(r.json.result.signIn);
          if (!r.ok) failed = r;
        });
      });
    }, Promise.resolve()).then(function () {
      delete W.busy.parity;
      if (failed) say((failed.json && failed.json.result && failed.json.result.message) || plainError(failed.status, failed.json, failed.text), "err");
      // A server whose sign-in belonged to the agents' old copy needs one sign-in in the person's own setup.
      else if (signIn.length) say("One more sign-in each for " + signIn.join(", ") + " — run claude mcp login <name> in a terminal.");
      render();
    });
  }

  function createProject() {
    var folder = W.folder.trim();
    if (!folder || W.creating) return;
    W.creating = true; say(""); render();
    var fail = function (msg) { W.creating = false; say(msg, "err"); render(); };
    call("GET", "/onboarding/folder?path=" + encodeURIComponent(folder)).then(function (f) {
      if (!f.ok) return fail(plainError(f.status, f.json, f.text));
      var F = f.json;
      if (!F.exists) return fail("There's no folder at " + folder + ".");
      if (!F.dir) return fail("That's a file — pick the folder it's in.");
      var name = W.pname.trim() || F.name;
      var body = { slug: slugify(name), name: name, config_dir: F.profile };
      var be = W.status && W.status.clis ? preferredBackend(W.status.clis) : null;
      if (be) body.default_backend = be;
      if (!F.git) body.default_dir = F.path;
      var attempt = function (n) {
        return call("POST", "/workspaces", body).then(function (w) {
          if (w.status === 409 && /slug already exists/.test((w.json && w.json.error) || "") && n < 9) {
            body.slug = slugify(name) + "-" + (n + 1);
            return attempt(n + 1);
          }
          return w;
        });
      };
      return attempt(1).then(function (w) {
        if (!w.ok) return fail(plainError(w.status, w.json, w.text));
        var ws = w.json;
        var done = function (note) {
          W.creating = false;
          W.project = { id: ws.id, slug: ws.slug, name: ws.name, note: note };
          if (P().load) { try { P().load(); } catch (e) {} }
          render();
        };
        if (!F.git) return done("not a git repo, so agents work in the folder directly.");
        var repo = { name: F.name, path: F.path, delivery: F.remote ? "pr" : "commit" };
        if (!F.branch) repo.default_branch = "main";
        return call("POST", "/workspaces/" + encodeURIComponent(ws.id) + "/repos", repo).then(function (r) {
          if (r.ok) return done(F.remote ? "a git repo, so agents open pull requests." : "a git repo with no remote, so agents commit locally.");
          // Still a project: its terminals open in the folder (the repo can be added from ⚙ Settings later).
          return call("PATCH", "/workspaces/" + encodeURIComponent(ws.id), { default_dir: F.path }).then(function () {
            done("agents work in the folder directly (" + plainError(r.status, r.json, r.text).replace(/\.$/, "").toLowerCase() + ").");
          });
        });
      });
    });
  }

  function markDone() {
    if (W.done) return Promise.resolve();
    W.done = true;
    return call("PUT", "/onboarding", { done: true });
  }

  function finish(then) {
    markDone();
    W.open = false;
    if (W.dlg) { try { W.dlg.close(); } catch (e) {} W.dlg.remove(); W.dlg = null; }
    toConversation();
    if (then) then(); // a chip's message lands first, so the empty hint never flashes in between
    syncHint();
  }

  /**
   * The conversation on screen. Nothing running: the stage IS the conversation (Focus), and the board's
   * one automatic turn (desk.html renderStage, DW.auto) is spent — creating the project re-rendered the
   * Desk, and an empty board of zeros is not where a welcome should leave anyone. Something running:
   * the conversation's column opens beside it.
   */
  function toConversation() {
    var p = P();
    var live = p.S && Array.isArray(p.S.sessions) && p.S.sessions.some(function (x) { return x.live; });
    if (live) { if (p.chatOpen && p.chatIsOpen && !p.chatIsOpen()) p.chatOpen(true); return; }
    if (p.DW) p.DW.auto = true;
    if (p.setMode && p.S && p.S.mode !== "focus") p.setMode("focus");
  }

  /** A real message, as if typed into the composer, where it can be seen. */
  function send(text) {
    var p = P();
    if (!p.queueAsk || !text) return;
    toConversation();
    p.queueAsk(text);
  }

  // ── wiring ───────────────────────────────────────────────────────────────────────────────────────
  function onClick(e) {
    var t = e.target.closest("[data-act], [data-chip]");
    if (!t || !W.dlg || !W.dlg.contains(t)) return;
    if (t.hasAttribute("data-chip")) {
      var c = chips(W.project && W.project.slug)[Number(t.getAttribute("data-chip"))];
      if (!c) return;
      if (c.href) { root.open(c.href, "_blank", "noopener"); return finish(); }
      return finish(function () { send(c.say); });
    }
    var act = t.getAttribute("data-act");
    if (act === "next") return; // the form's submit does it (Enter too)
    if (act === "skipall") return finish();
    if (act === "skip") return next();
    if (act === "more") { W.more = true; return render(); }
    if (act === "recheck") { W.result = {}; say("Checking again…"); render(); return loadStatus(true).then(function () { say(""); render(); }); }
    if (act === "parity") return bringTools();
    if (act === "test" || act === "install" || act === "signin" || act === "copy") return cliAct(act, t.getAttribute("data-id"));
  }
  function onSubmit(e) {
    e.preventDefault();
    var btn = W.dlg && W.dlg.querySelector('[data-act="next"]');
    if (!btn || btn.disabled) return;
    var step = STEPS[W.step];
    if (step === "name") return saveName();
    if (step === "project" && !W.project) return createProject();
    if (step === "phone" && phoneDialog() && !W.phoneOpened) {
      W.phoneOpened = true; render();
      try { root.ChronosPhone.open(); } catch (x) {}
      return;
    }
    if (step === "meet") return finish();
    next();
  }
  function onInput(e) {
    var t = e.target;
    if (t.id === "dw-name") {
      W.nameDraft = t.value;
      var ok = AN.valid(cleanName(t.value));
      say(ok || !t.value.trim() ? "" : "Letters, digits, spaces and . - ' only — up to 24.", ok ? "" : "err");
      syncFoot(ok);
    } else if (t.id === "dw-folder") {
      W.folder = t.value;
      if (W.msg) { say(""); var old = W.dlg.querySelector(".dw-msg"); if (old) old.remove(); } // a new path: the old complaint goes
      var pn = W.dlg.querySelector("#dw-pname");
      if (pn) pn.placeholder = baseName(t.value) || "my-app";
      syncFoot(!!t.value.trim());
    } else if (t.id === "dw-pname") {
      W.pname = t.value;
    }
  }
  /** Only the button and the message change while typing — re-rendering would steal the caret. */
  function syncFoot(ok) {
    var b = W.dlg.querySelector('[data-act="next"]');
    if (b) b.disabled = !ok;
    var m = W.dlg.querySelector(".dw-msg");
    if (m) { m.textContent = W.msg; m.className = "dw-msg " + W.msgKind; }
  }

  function open(at) {
    if (W.dlg) return;
    if (!doc.getElementById("dw-css")) {
      var st = doc.createElement("style"); st.id = "dw-css"; st.textContent = CSS; doc.head.appendChild(st);
    }
    var d = doc.createElement("dialog");
    d.id = "dlg-welcome";
    d.setAttribute("aria-labelledby", "dw-t");
    d.innerHTML = '<form class="dw-in" novalidate></form>';
    doc.body.appendChild(d);
    W.dlg = d; W.open = true; W.step = at ? Math.max(0, STEPS.indexOf(at)) : 0; say("");
    // Opened again (the empty Desk's "Add a project"): that step starts clean, not on the last success.
    if (at === "project") { W.project = null; W.folder = ""; W.pname = ""; W.creating = false; }
    // Esc must not throw the welcome away by accident — "Skip setup" is the way out.
    d.addEventListener("cancel", function (e) { e.preventDefault(); });
    d.addEventListener("click", onClick);
    d.addEventListener("submit", onSubmit);
    d.addEventListener("input", onInput);
    d.showModal();
    syncHint();
    go(W.step);
    // Is there a phone guide to point at (docs/guide/phone.md, served at /guide/phone)? Asked once, early.
    if (W.phoneGuide === null) {
      root.fetch("/guide/phone.md", { method: "HEAD" }).then(function (r) { W.phoneGuide = r.ok; }, function () { W.phoneGuide = false; });
    }
  }

  // Back from the browser (a sign-in, an install in a terminal): look again, at most every few seconds.
  root.addEventListener("focus", function () {
    if (!W.open || STEPS[W.step] !== "agents" || !W.status || W.status.unavailable) return;
    if (Object.keys(W.busy).length || Date.now() - W.statusAt < 4000) return;
    loadStatus(true);
  });
  root.addEventListener("assistant-name", function () { if (W.open) render(); syncHint(true); });

  // ── the empty Desk ───────────────────────────────────────────────────────────────────────────────
  // Nothing running and an empty conversation: one line on what to do next, two chips. Gone the moment
  // anything lands in the conversation; back when it is empty again.
  function projects() { var s = P().S; return s && Array.isArray(s.workspaces) ? s.workspaces : null; }
  function emptyHint() {
    var n = AN.get();
    var el = doc.createElement("div");
    el.className = "dw-empty"; el.id = "dw-empty";
    var list = projects();
    var noProject = !!list && list.length === 0;
    // One project: the first task lands there (#slug routes it), as the welcome's own chip does.
    var first = list && list.length === 1 ? chips(list[0].slug)[2].say : chips(null)[2].say;
    el.innerHTML = "<b>Nothing running yet</b><span>" +
      esc(noProject ? "Add a project — a folder your agents work in — then tell " + n + " what you want done." : "Tell " + n + " what you want done, or start an agent yourself with + Terminal.") +
      '</span><div class="dw-chips"><button type="button" data-say="What can you do?">What can you do?</button>' +
      (noProject ? '<button type="button" data-hint="project">Add a project</button>' : '<button type="button" data-say="' + esc(first) + '">Start my first task</button>') + "</div>";
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.getAttribute("data-hint") === "project") return open("project");
      send(b.getAttribute("data-say"));
    });
    return el;
  }
  function syncHint(rebuild) {
    var log = doc.getElementById("chat-log");
    if (!log) return;
    var hint = doc.getElementById("dw-empty");
    var b = doc.body.classList;
    var other = Array.prototype.some.call(log.children, function (c) { return c !== hint; });
    var want = !W.open && b.contains("no-terms") && !b.contains("mode-fleet") && !other && !P().LOCK;
    if (hint && (!want || rebuild)) { hint.remove(); hint = null; }
    if (want && !hint) log.insertBefore(emptyHint(), log.firstChild);
  }
  function watchEmpty() {
    var log = doc.getElementById("chat-log");
    if (!log || !root.MutationObserver) return;
    var soon = 0;
    var tick = function () { clearTimeout(soon); soon = setTimeout(function () { syncHint(); }, 60); };
    new root.MutationObserver(tick).observe(log, { childList: true });
    new root.MutationObserver(tick).observe(doc.body, { attributes: true, attributeFilter: ["class"] });
    syncHint();
  }

  // ── boot ─────────────────────────────────────────────────────────────────────────────────────────
  function start() {
    if (!token()) return; // the sign-in comes first
    watchEmpty();
    if (P().LOCK) return; // a screen share of one client is no time for a welcome
    Promise.all([call("GET", "/onboarding"), call("GET", "/workspaces")]).then(function (rs) {
      var ob = rs[0], ws = rs[1];
      if (!ob.ok || !ob.json || !ws.ok || !Array.isArray(ws.json)) return;
      var live = ws.json.filter(function (w) { return !w.archived; }).length;
      if (shouldShow(ob.json.done, live)) open();
    });
  }

  root.DeskWelcome = Object.assign({ open: open, syncHint: syncHint }, pure);
  var first = P().booted;
  (first && typeof first.then === "function" ? first : Promise.resolve()).then(start, start);
})(typeof window !== "undefined" ? window : globalThis);

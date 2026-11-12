/* The Desk's Phone dialog — a phone paired in about a minute: no domain, no Cloudflare account.
 *
 * One button turns on `tailscale serve` for this daemon (src/phone-access.ts), and the dialog then
 * shows a QR code of https://<machine>.<tailnet>.ts.net/phone#pair=<code>. The phone's camera opens
 * it, static/pair.js trades the single-use code (POST /api/pair, five minutes) for the token, and the
 * phone is signed in. Only the owner's Tailscale account gets through to that address at all
 * (src/phone-gate.ts). A Mac that already has the Cloudflare tunnel of CONFIGURATION.md §4 gets its
 * QR pointed there instead.
 *
 * window.ChronosPhone.open() — from the "⋯" menu (#btn-phone) and the onboarding wizard.
 *
 * The QR encoder (static/vendor/qrcode.js) loads on first open, so the Desk doesn't pay for it
 * otherwise. Colours are theme tokens; the code itself is always dark modules on a light field with
 * a four-module quiet zone, whatever the theme, because phone cameras read an inverted code badly or
 * not at all — --term-bg / --term-ink are the one token pair that stays dark/light in both themes.
 */
(function (root) {
  "use strict";
  var QUIET = 4;
  var QR_SRC = "/vendor/qrcode.js";
  var GUIDE = "/guide/phone";
  var PHONE_APPS = {
    ios: "https://apps.apple.com/us/app/tailscale/id1470499037",
    android: "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
  };

  // ── pure: tested in a vm (src/desk-phone.test.ts) ──────────────────────────────────────────────
  /** The link the QR carries. No code (pairing unavailable) = the bare page. */
  function pairUrl(base, code) {
    var b = String(base || "").replace(/\/+$/, "");
    return code ? b + "/phone#pair=" + encodeURIComponent(code) : b + "/phone";
  }
  /** The code's dark/light modules, from the vendored encoder (error correction M: 15%). */
  function qrModules(qrcode, text) {
    var qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount(), rows = [];
    for (var r = 0; r < n; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(qr.isDark(r, c));
      rows.push(row);
    }
    return rows;
  }
  /** One SVG path, one unit per module, the quiet zone inside the viewBox — the field is the box behind it. */
  function qrSvg(rows) {
    var n = rows.length, size = n + 2 * QUIET, d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (rows[r][c]) d += "M" + (c + QUIET) + " " + (r + QUIET) + "h1v1h-1z";
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges" role="img" aria-label="QR code of the pairing link"><path fill="currentColor" d="' + d + '"/></svg>';
  }
  /** "4:59" until it expires, then null. */
  function left(expiresAt, now) {
    var ms = Date.parse(expiresAt) - now;
    if (!(ms > 0)) return null;
    var s = Math.ceil(ms / 1000);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }
  /** What the dialog shows for a GET /api/phone/status answer: the QR, or the next step. */
  function viewFor(st) {
    if (st && st.method && st.url) return { kind: "qr", method: st.method, base: st.url };
    var ts = (st && st.tailscale) || {};
    var cf = (st && st.cloudflare) || {};
    return {
      kind: "steps",
      step: ts.step || "error",
      message: ts.message || "Couldn't read how a phone would reach this Mac.",
      fix: ts.fix || null,
      enable: ts.step === "ready" || ts.step === "funnel",
      phoneApps: ts.step === "missing",
      cfUnknown: !!cf.configured && !cf.url,
    };
  }

  var api = { pairUrl: pairUrl, qrModules: qrModules, qrSvg: qrSvg, left: left, viewFor: viewFor };
  root.ChronosPhone = { open: function () {}, _: api };
  if (typeof document === "undefined") return;

  // ── the dialog ─────────────────────────────────────────────────────────────────────────────────
  var CSS = [
    "#dlg-phone { width:min(420px,92vw); }",
    "#dlg-phone h3 { justify-content:space-between; }",
    "#dlg-phone .ph-x { padding:2px 8px; font-size:15px; }",
    ".ph-p { margin:0; font-size:15px; line-height:1.45; color:var(--ink); }",
    ".ph-small { margin:0; font-size:13px; line-height:1.4; color:var(--muted); }",
    ".ph-small a, .ph-p a { color:var(--accent); }",
    ".ph-err { margin:0; font-size:13.5px; line-height:1.4; color:var(--danger); background:var(--danger-soft); border-radius:8px; padding:8px 10px; }",
    ".ph-line { display:flex; gap:8px; align-items:center; background:var(--surface-2); border:1px solid var(--line); border-radius:8px; padding:5px 5px 5px 10px; }",
    ".ph-line code { flex:1; min-width:0; font-size:13px; line-height:1.35; overflow-wrap:anywhere; color:var(--ink); }",
    ".ph-line .btn { flex:none; padding:4px 10px; font-size:13.5px; }",
    ".ph-qrbox { display:flex; justify-content:center; }",
    ".ph-qr { width:232px; max-width:70vw; background:var(--term-ink); color:var(--term-bg); border-radius:10px; line-height:0; }",
    ".ph-qr svg { display:block; width:100%; height:auto; }",
    ".ph-qr.ph-old { opacity:.2; }",
    ".ph-making { margin:0; padding:96px 16px; text-align:center; font-size:13px; line-height:1.4; }",
    ".ph-steps { margin:0; padding-left:20px; font-size:15px; line-height:1.5; }",
    "#dlg-phone .actions .btn { white-space:nowrap; }",
    ".ph-hd { display:flex; align-items:center; gap:10px; }",
    ".ph-guide { font-size:13.5px; font-weight:500; color:var(--muted); }",
    ".ph-guide:hover { color:var(--accent); }",
  ].join("\n");

  var dlg = null, body = null, tick = null, qrLoad = null;
  var S = { status: null, pair: null, err: "", busy: "" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }
  function token() {
    try { return root.__MC_TOKEN__ || localStorage.getItem("mc-token"); } catch (e) { return root.__MC_TOKEN__ || null; }
  }
  /** fetch /api with the Desk's token; a failure carries the daemon's own words. */
  function call(path, opts) {
    var headers = { "content-type": "application/json" };
    var t = token();
    if (t) headers["x-mc-admin"] = t;
    return fetch("/api" + path, Object.assign({}, opts || {}, { headers: headers })).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && data.error) || txt.slice(0, 200) || "HTTP " + r.status);
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }
  function loadQr() {
    if (root.qrcode) return Promise.resolve(root.qrcode);
    if (!qrLoad) {
      qrLoad = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = QR_SRC;
        s.onload = function () { if (root.qrcode) resolve(root.qrcode); else reject(new Error("the QR encoder didn't load")); };
        s.onerror = function () { qrLoad = null; reject(new Error("the QR encoder didn't load")); };
        document.head.appendChild(s);
      });
    }
    return qrLoad;
  }

  function ensure() {
    if (dlg) return;
    var st = document.createElement("style");
    st.id = "desk-phone-css";
    st.textContent = CSS;
    document.head.appendChild(st);
    dlg = document.createElement("dialog");
    dlg.id = "dlg-phone";
    dlg.innerHTML = '<div class="dlg"><h3><span>📱 Phone</span><span class="ph-hd"><a class="ph-guide" href="' + GUIDE + '" target="_blank" rel="noopener">How it works</a><button type="button" class="btn ghost ph-x" aria-label="Close">✕</button></span></h3><div class="ph-body"></div></div>';
    document.body.appendChild(dlg);
    body = dlg.querySelector(".ph-body");
    dlg.querySelector(".ph-x").addEventListener("click", function () { dlg.close(); });
    dlg.addEventListener("close", function () { clearInterval(tick); tick = null; });
    dlg.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act],[data-copy]");
      if (!b || b.disabled) return;
      if (b.hasAttribute("data-copy")) return copy(b);
      var act = b.getAttribute("data-act");
      if (act === "check") load();
      else if (act === "enable") enable();
      else if (act === "pair") pair();
    });
  }

  function copy(b) {
    var text = b.getAttribute("data-copy");
    var done = function () { var was = b.textContent; b.textContent = "Copied"; setTimeout(function () { b.textContent = was; }, 1500); };
    try {
      navigator.clipboard.writeText(text).then(done, function () { selectNext(b); });
    } catch (e) { selectNext(b); }
  }
  function selectNext(b) {
    var code = b.parentNode && b.parentNode.querySelector("code");
    if (!code) return;
    var r = document.createRange();
    r.selectNodeContents(code);
    var sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function actions(buttons) {
    return '<div class="actions">' + buttons + "</div>";
  }
  function render() {
    clearInterval(tick); tick = null;
    if (!S.status) {
      body.innerHTML = S.err ? '<p class="ph-err">' + esc(S.err) + "</p>" + actions('<button type="button" class="btn" data-act="check">Check again</button>') : '<p class="ph-p">Checking how your phone can reach this Mac…</p>';
      return;
    }
    var v = viewFor(S.status);
    if (v.kind === "qr") return renderQr(v);
    var h = '<p class="ph-p">' + esc(v.message) + "</p>";
    var fix = v.fix || {};
    if (fix.command) h += '<div class="ph-line"><code class="mono">' + esc(fix.command) + '</code><button type="button" class="btn" data-copy="' + esc(fix.command) + '">Copy</button></div>';
    if (/^https:\/\//.test(fix.link || "")) h += '<p class="ph-small"><a href="' + esc(fix.link) + '" target="_blank" rel="noopener">' + esc(fix.label || "Open") + " ↗</a></p>";
    if (v.phoneApps) h += '<p class="ph-small">Your phone needs it too: Tailscale from the <a href="' + PHONE_APPS.ios + '" target="_blank" rel="noopener">App Store</a> or <a href="' + PHONE_APPS.android + '" target="_blank" rel="noopener">Google Play</a>.</p>';
    if (v.cfUnknown) h += '<p class="ph-small">This Mac has a Cloudflare tunnel, but Chronos doesn\'t know its address. Set <code class="mono">CHRONOS_DESK_URL</code> in <code class="mono">.secrets</code> to use it here.</p>';
    if (S.err) h += '<p class="ph-err">' + esc(S.err) + "</p>";
    var btns = '<button type="button" class="btn" data-act="check"' + (S.busy ? " disabled" : "") + ">Check again</button>";
    if (v.enable) btns += '<button type="button" class="btn primary" data-act="enable"' + (S.busy ? " disabled" : "") + ">" + (S.busy === "enable" ? "Turning on…" : "Turn on phone access") + "</button>";
    body.innerHTML = h + actions(btns);
  }

  function renderQr(v) {
    var p = S.pair || {};
    var link = pairUrl(v.base, p.code);
    var svg = "";
    try { svg = p.qrcode ? qrSvg(qrModules(p.qrcode, link)) : ""; } catch (e) { S.err = "Couldn't draw the QR code: " + e.message; }
    var steps = v.method === "tailscale"
      ? "<li>Install Tailscale on your phone and sign in with the same account.</li><li>Scan this with the camera.</li>"
      : "<li>Scan this with the camera.</li><li>If Cloudflare asks you to sign in first, scan it again afterwards.</li>";
    var h = '<div class="ph-qrbox"><div class="ph-qr" id="ph-qr">' + (svg || '<p class="ph-making">making a code…</p>') + "</div></div>";
    h += '<ol class="ph-steps">' + steps + "</ol>";
    h += '<div class="ph-line"><code class="mono">' + esc(link) + '</code><button type="button" class="btn" data-copy="' + esc(link) + '">Copy</button></div>';
    if (p.code) h += '<p class="ph-small" id="ph-exp"></p>';
    if (p.error) h += '<p class="ph-err">' + esc(p.error) + "</p>";
    if (S.err) h += '<p class="ph-err">' + esc(S.err) + "</p>";
    body.innerHTML = h + actions('<button type="button" class="btn" data-act="pair"' + (S.busy ? " disabled" : "") + ">New code</button>");
    if (p.code) {
      var paint = function () {
        var el = document.getElementById("ph-exp"), qr = document.getElementById("ph-qr");
        if (!el) return;
        var l = left(p.expires_at, Date.now());
        el.textContent = l ? "Works once · expires in " + l : "This code expired — make a new one.";
        if (qr) qr.classList.toggle("ph-old", !l);
        if (!l) { clearInterval(tick); tick = null; }
      };
      paint();
      tick = setInterval(paint, 1000);
    }
  }

  function load() {
    S.err = "";
    S.busy = "check";
    if (S.status) render();
    return call("/phone/status").then(function (st) {
      S.status = st;
      S.busy = "";
      if (viewFor(st).kind === "qr") return pair();
      render();
    }, function (e) {
      S.busy = "";
      S.err = e.status === 403 ? "Sign the Desk in first (its admin token), then open Phone again." : "Couldn't check: " + e.message;
      render();
    });
  }

  function enable() {
    S.err = "";
    S.busy = "enable";
    render();
    return call("/phone/tailscale/enable", { method: "POST", body: "{}" }).then(function () {
      S.busy = "";
      return load();
    }, function (e) {
      S.busy = "";
      S.err = e.message;
      // The daemon's next step for this failure (a link Tailscale printed, a command) replaces the old one.
      if (e.data && e.data.fix && S.status && S.status.tailscale) S.status.tailscale.fix = e.data.fix;
      render();
    });
  }

  function pair() {
    S.busy = "pair";
    S.err = "";
    var got = { code: null, expires_at: null, error: "", qrcode: null };
    return loadQr().then(function (q) {
      got.qrcode = q;
      return call("/pair", { method: "POST", body: "{}" }).then(function (r) {
        got.code = r && r.code;
        got.expires_at = r && r.expires_at;
      }, function (e) {
        got.error = e.status === 404
          ? "This Chronos can't make pairing codes yet — the phone will ask for the admin token instead."
          : "Couldn't make a pairing code: " + e.message;
      });
    }, function (e) {
      got.error = "Couldn't draw the QR code (" + e.message + ") — copy the link instead.";
    }).then(function () {
      S.pair = got;
      S.busy = "";
      render();
    });
  }

  function open() {
    ensure();
    S.status = null; S.pair = null; S.err = ""; S.busy = "";
    render();
    if (!dlg.open) dlg.showModal();
    return load();
  }

  root.ChronosPhone = { open: open, _: api };
  function hook() {
    var b = document.getElementById("btn-phone");
    if (b && !b.__chronosPhone) { b.__chronosPhone = true; b.addEventListener("click", function () { open(); }); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hook);
  else hook();
})(typeof window !== "undefined" ? window : globalThis);

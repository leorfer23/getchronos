/* After pairing: install the phone app — one small banner, dismissable, shown until it's done.
 *
 * Android (Chrome, Edge, Samsung Internet): the browser's own install prompt (`beforeinstallprompt`),
 * one tap. The installed app shares the browser's storage, so it opens signed in.
 *
 * iPhone/iPad: there is no prompt — Share → Add to Home Screen. And an iOS Home Screen app starts
 * with its own empty storage, not Safari's ("Home Screen apps are created as isolated entities
 * without shared state with the browser" — WebKit, bugs.webkit.org/show_bug.cgi?id=181849), so the
 * token this page just got is not there and the app would open asking for the admin token. The
 * banner's Copy link makes a fresh single-use pairing link (POST /api/pair, from this signed-in page)
 * and puts it on the clipboard; pasted into the app's token prompt, it signs the app in
 * (redeemPasted → static/pair.js). It works once, for five minutes, and only through the owner gate
 * (src/phone-gate.ts) — nothing long-lived ever sits on the clipboard.
 *
 * Shown when: a phone (never the Mac's full-screen front), signed in and loaded (so pairing worked),
 * in the browser rather than the installed app, and never dismissed here. ✕ or an install = gone.
 */
(function (root) {
  "use strict";
  var KEY = "mc-install-hint"; // "done" once dismissed or installed

  // ── pure: tested in a vm (src/phone-install.test.ts) ───────────────────────────────────────────
  function platform(ua, touchPoints) {
    if (/iP(hone|ad|od)/.test(ua) || (touchPoints > 1 && /Macintosh/.test(ua))) return "ios"; // iPadOS says Macintosh
    if (/Android/.test(ua)) return "android";
    return "other";
  }
  function shouldShow(o) {
    if (!o.signedIn || o.standalone || o.dismissed) return false;
    return o.platform === "ios" || (o.platform === "android" && !!o.canPrompt);
  }
  /** The code in a pasted pairing link (…/phone#pair=<code>), or null — a pasted token is not one. */
  function pairCode(text) {
    var m = /(?:^|[#&?\s])pair=([A-Za-z0-9_-]{16,})(?:$|[&\s])/.exec(String(text == null ? "" : text).trim());
    return m ? m[1] : null;
  }

  var api = { platform: platform, shouldShow: shouldShow, pairCode: pairCode };
  root.PhoneInstall = { _: api, owns: function () { return false; }, redeemPasted: function () { return false; } };
  if (typeof document === "undefined") return;

  var plat = platform(navigator.userAgent || "", navigator.maxTouchPoints || 0);
  var deferred = null, row = null, loaded = false;
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function standalone() { return (!!root.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; }
  function state() {
    return { platform: plat, signedIn: !!get("mc-token"), standalone: standalone(), dismissed: get(KEY) === "done", canPrompt: !!deferred };
  }

  // Caught as early as it fires (often before the page has its data). Chrome's own mini-infobar is
  // held back only while the banner is going to offer the same install.
  root.addEventListener("beforeinstallprompt", function (e) {
    if (get(KEY) === "done" || standalone()) return;
    e.preventDefault();
    deferred = e;
    show();
  });
  root.addEventListener("appinstalled", function () { put(KEY, "done"); hide(); });
  document.addEventListener("phone:loaded", function () { loaded = true; show(); });

  function hide() { if (row) row.hidden = true; }
  function text(t, s) { row.querySelector(".ip-t").textContent = t; row.querySelector(".ip-s").textContent = s; }
  function show() {
    if (!loaded || !shouldShow(state())) return;
    if (!row) {
      // The alerts row's look (.nrow in phone.html), so the conversation keeps one kind of banner.
      row = document.createElement("div");
      row.className = "nrow";
      row.id = "irow";
      row.innerHTML = '<span class="ni"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg></span><span class="tx"><b class="ip-t"></b><span class="ip-s"></span></span><button class="go" id="ip-go"></button><button class="no" id="ip-no" aria-label="Not now">✕</button>';
      var anchor = document.getElementById("nrow");
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(row, anchor.nextSibling);
      else document.body.insertBefore(row, document.body.firstChild);
      row.querySelector("#ip-no").onclick = function () { put(KEY, "done"); hide(); };
      row.querySelector("#ip-go").onclick = function () { (plat === "ios" ? copyLink : prompt)(); };
    }
    if (plat === "ios") {
      text("Install the app", "Share → Add to Home Screen. It signs in separately: copy this link and paste it there.");
      row.querySelector("#ip-go").textContent = "Copy link";
    } else {
      text("Install the app", "One tap: it opens like an app and gets alerts.");
      row.querySelector("#ip-go").textContent = "Install";
    }
    row.hidden = false;
  }

  function prompt() {
    if (!deferred) return;
    var e = deferred;
    deferred = null;
    e.prompt();
    Promise.resolve(e.userChoice).then(function (c) {
      if (c && c.outcome === "accepted") { put(KEY, "done"); hide(); }
    }, function () {});
  }

  /** A fresh single-use link for the Home Screen app — never the token itself. */
  function freshLink() {
    var tok = get("mc-token");
    return fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json", "x-mc-admin": tok || "" }, body: "{}" })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 404 ? "this Chronos can't make sign-in links yet" : "couldn't make a link (" + r.status + ")"); return r.json(); })
      .then(function (d) { return location.origin + "/phone#pair=" + encodeURIComponent(d.code); });
  }
  function copyLink() {
    var go = row.querySelector("#ip-go");
    go.disabled = true;
    var link = freshLink();
    var wrote;
    // Safari only lets a page write the clipboard inside the tap; a ClipboardItem holding a promise
    // keeps that tap alive while the link is fetched.
    if (root.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      wrote = navigator.clipboard.write([new root.ClipboardItem({ "text/plain": link.then(function (l) { return new Blob([l], { type: "text/plain" }); }) })]);
    } else {
      wrote = link.then(function (l) { return navigator.clipboard.writeText(l); });
    }
    Promise.all([link, wrote]).then(function () {
      text("Link copied", "Now Share → Add to Home Screen, open it and paste. Works once, for 5 minutes.");
      go.textContent = "Copy again";
      go.disabled = false;
    }, function (err) {
      text("Couldn't copy", String((err && err.message) || err).slice(0, 120) + ". On the Mac: Desk → ⋯ → Phone → Copy, then paste it in the app.");
      go.disabled = false;
    });
  }

  root.PhoneInstall = {
    _: api,
    /** True while this banner carries the Home Screen advice for this phone (phone.html's alerts row then stays quiet). */
    owns: function (p) { return p === plat && plat === "ios" && shouldShow(state()); },
    /** A pairing link pasted where a token goes: reload onto it so static/pair.js redeems it. True = handled. */
    redeemPasted: function (t) {
      var code = pairCode(t);
      if (!code) return false;
      history.replaceState(null, "", location.pathname + "#pair=" + encodeURIComponent(code));
      location.reload();
      return true;
    },
  };
})(typeof window !== "undefined" ? window : globalThis);

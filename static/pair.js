// Signing this browser in from a one-time link. `npm run desk` (scripts/open-desk.mjs) — or the phone's
// QR code — opens a page at …#pair=<code>; this trades the code for the admin token once
// (POST /api/pair/redeem, src/pair.ts), keeps it where every page already reads it
// (localStorage "mc-token": desk, phone, app, altitude and bar all use that key) and reloads signed in.
//
// Loaded in <head>, before the page's own script, so the code is out of the address bar and the
// history before anything else can see it, and the page stays hidden for the moment the trade takes —
// otherwise the "paste your token" prompt flashes up first. Every other part of the hash (the Desk's
// #jobs, Altitude's filters) is left alone.
(function (win) {
  "use strict";
  var KEY = "mc-token";
  var PAIR = /^pair=([A-Za-z0-9_-]{16,200})$/;

  /** The code in a location hash, or null. */
  function codeFrom(hash) {
    var parts = String(hash || "").replace(/^#/, "").split("&");
    for (var i = 0; i < parts.length; i++) {
      var m = PAIR.exec(parts[i]);
      if (m) return m[1];
    }
    return null;
  }

  /** The hash without its pair= part ("" when nothing else was in it). */
  function hashWithout(hash) {
    var rest = String(hash || "").replace(/^#/, "").split("&").filter(function (p) { return p && !/^pair=/.test(p); });
    return rest.length ? "#" + rest.join("&") : "";
  }

  /** A plain line at the top of the page — the sign-in did not happen, and why. */
  function note(doc, text) {
    if (!doc || !doc.body) return;
    var el = doc.createElement("div");
    el.setAttribute("role", "alert");
    el.textContent = text;
    el.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,92vw);" +
      "padding:10px 14px;border-radius:10px;font:14px/1.4 -apple-system,system-ui,sans-serif;" +
      "background:var(--panel,Canvas);color:var(--text,CanvasText);border:1px solid var(--line,GrayText);box-shadow:0 6px 24px rgba(0,0,0,.25)";
    doc.body.appendChild(el);
  }

  function show(doc, root, text) {
    if (root) root.style.visibility = "";
    var put = function () { note(doc, text); };
    if (doc && doc.body) put();
    else if (doc && doc.addEventListener) doc.addEventListener("DOMContentLoaded", put);
  }

  /** Redeem the code in this window's hash, if there is one. Resolves "paired" | "refused" | "offline" | "no-storage", or null with no code. */
  function pair(w) {
    var code = codeFrom(w.location.hash);
    if (!code) return null;
    var doc = w.document, root = doc && doc.documentElement;
    try { w.history.replaceState(w.history.state, "", w.location.pathname + w.location.search + hashWithout(w.location.hash)); } catch (e) {}
    if (root) root.style.visibility = "hidden";
    return w.fetch("/api/pair/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code }),
      credentials: "same-origin",
      cache: "no-store",
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
    }).then(function (res) {
      if (res.status === 200 && typeof res.body.token === "string" && res.body.token) {
        try {
          w.localStorage.setItem(KEY, res.body.token);
        } catch (e) {
          show(doc, root, "This browser won't keep the sign-in (a private window?). Open the Desk in a normal window and run npm run desk again.");
          return "no-storage";
        }
        w.location.reload();
        return "paired";
      }
      show(doc, root, typeof res.body.error === "string" ? res.body.error : "That sign-in link didn't work — run npm run desk again.");
      return "refused";
    }, function () {
      show(doc, root, "Couldn't reach Chronos to sign in. Is it still running? Then run npm run desk again.");
      return "offline";
    });
  }

  win.ChronosPair = { codeFrom: codeFrom, hashWithout: hashWithout, pair: pair };
  pair(win);
  // A link pasted into a tab that already shows this page is a hash change, not a load.
  if (win.addEventListener) win.addEventListener("hashchange", function () { pair(win); });
})(window);

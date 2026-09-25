/* Chronos phone service worker: push notifications with answer buttons, the app-icon badge, and an
 * offline shell so the page opens instantly and shows the last list while it reconnects.
 * Served at /sw.js with no-store (src/api.ts), scope "/". */
const VERSION = "v9";
const SHELL = "chronos-shell-" + VERSION;
const SHELL_URLS = ["/phone", "/phone.html", "/phone.webmanifest", "/phone-icon.png",
  "/vendor/xterm.css", "/vendor/xterm.js", "/vendor/xterm-addon-fit.js", "/term-links.js", "/tag-complete.js", "/chat-reply.js",
  "/vendor/marked.min.js", "/vendor/purify.min.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("chronos-shell-") && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// The admin token, handed over by the page so a notification button can type into a terminal
// without opening the app. IndexedDB, because a worker has no localStorage.
const DB = "chronos-sw", STORE = "kv";
function kv() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) { const d = await kv(); return new Promise((res) => { const q = d.transaction(STORE).objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function kvSet(k, v) { const d = await kv(); return new Promise((res) => { const t = d.transaction(STORE, "readwrite"); t.objectStore(STORE).put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); }

self.addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.type === "token") kvSet("token", m.token || "");
  if (m.type === "skipWaiting") self.skipWaiting();
});

// Shell: network first for the page (so an update lands on the next open), cache fallback when the
// tunnel is unreachable; cache first for the vendor bundles, which only change with a version bump.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname === "/ws" || url.pathname === "/term" || url.pathname === "/sw.js") return;
  const isShell = SHELL_URLS.includes(url.pathname);
  if (!isShell) return;
  const vendor = url.pathname.startsWith("/vendor/");
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    if (vendor) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
    }
    try {
      const res = await fetch(e.request);
      // Only a real 200 from our origin goes in: an Access login redirect must never become the shell.
      if (res.ok && res.type === "basic" && !res.redirected) cache.put(e.request, res.clone());
      return res;
    } catch {
      const hit = await cache.match(e.request) || (url.pathname === "/phone" ? await cache.match("/phone.html") : null);
      return hit || new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
    }
  })());
});

async function visibleClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => c.visibilityState === "visible" && c.focused) || null;
}

self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: "Chronos", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    try { if (typeof p.needs === "number") { if (p.needs > 0) await self.registration.setAppBadge?.(p.needs); else await self.registration.clearAppBadge?.(); } } catch {}
    // Looking at the app already: the page's own chime covers it, no tray entry.
    if (await visibleClient()) return;
    const actions = (p.actions || []).slice(0, 2).map((a) => ({ action: a.action, title: a.title }));
    await self.registration.showNotification(p.title || "Chronos", {
      body: p.body || "", tag: p.tag || "chronos", renotify: true,
      icon: "/phone-icon.png", badge: "/phone-icon.png",
      vibrate: p.kind === "blocked" ? [60, 40, 60, 40, 120] : p.kind === "robert" ? [20, 60, 20] : [40, 60, 40, 60, 80],
      data: { url: p.url || "/phone", session_id: p.session_id || null, actions: p.actions || [], kind: p.kind },
      actions,
    });
  })());
});

// A button answers straight from the tray through the same door the page uses. The body tap (or
// "Open") focuses the app on that terminal.
self.addEventListener("notificationclick", (e) => {
  const n = e.notification, d = n.data || {};
  const act = e.action && (d.actions || []).find((a) => a.action === e.action);
  n.close();
  e.waitUntil((async () => {
    if (act && d.session_id && act.input && Object.keys(act.input).length) {
      const token = await kvGet("token");
      try {
        const r = await fetch("/api/sessions/" + d.session_id + "/input", {
          method: "POST", credentials: "same-origin",
          headers: { "content-type": "application/json", ...(token ? { "x-mc-admin": token } : {}) },
          body: JSON.stringify({ ...act.input, by: "operator" }),
        });
        if (!r.ok) throw new Error(String(r.status));
        return;
      } catch {
        // Fall through: open the terminal so the answer can be given by hand.
      }
    }
    const url = new URL(d.url || "/phone", self.location.origin).href;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const c = all.find((x) => new URL(x.url).pathname.startsWith("/phone"));
    if (c) { try { await c.navigate(url); } catch {} return c.focus(); }
    return self.clients.openWindow(url);
  })());
});

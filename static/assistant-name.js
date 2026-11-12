/* The assistant's name, on every page (src/settings.ts `assistant.name` — GET /api/assistant).
 *
 * The operator names his assistant once (the Desk's welcome, or ⚙ Settings) and every surface says
 * it: labels, placeholders, toasts, the phone's title, the words a call listens for. Ids never move —
 * this only changes what a person reads or hears.
 *
 *   AssistantName.get()          the name now ("Robert" until he picks one)
 *   AssistantName.say(text)      the text with the name in place of "Robert" (whole word, capital R —
 *                                "robert" in an id or a command is never touched)
 *   AssistantName.apply(el)      fill the markup under el (default: the document). `data-an` lists
 *                                what to rewrite on an element: "text" (its text — leaf elements only)
 *                                and/or attribute names ("placeholder aria-label"). The original value
 *                                is kept as the template, so a second rename still finds "Robert".
 *   AssistantName.set(name)      a new name: kept, applied, and an `assistant-name` event on window
 *   AssistantName.refresh()      GET /api/assistant with this page's token, then set()
 *   AssistantName.words()        "robert", or "robert|ada" — what a call hears the name as
 *   AssistantName.command(w, l)  { test(n) } for a call's own words: n (normalised " … ") is one of
 *                                `w`, or one of `l` followed by the name ("chau ada", "para robert")
 *
 * The last name seen is kept in localStorage, so a reload paints it before the fetch lands.
 */
(function (root) {
  var DEFAULT = "Robert";
  var KEY = "mc-assistant-name";
  var name = DEFAULT;

  // The server's rule (settings.ts cleanAssistantName), checked again so a bad value never paints.
  function valid(n) {
    return typeof n === "string" && /^[\p{L}\p{M}\p{N} .'-]+$/u.test(n) && /[\p{L}\p{N}]/u.test(n) &&
      Array.from(n).length <= 24 && n.trim() === n;
  }
  function store() { try { return root.localStorage || null; } catch (e) { return null; } }
  (function () { var s = store(); var kept = null; try { kept = s && s.getItem(KEY); } catch (e) {} if (valid(kept)) name = kept; })();

  function say(text) {
    if (text == null) return text;
    var s = String(text);
    return name === DEFAULT ? s : s.replace(/\bRobert\b/g, function () { return name; });
  }

  function apply(el) {
    var scope = el || root.document;
    if (!scope || !scope.querySelectorAll) return;
    var nodes = Array.prototype.slice.call(scope.querySelectorAll("[data-an]"));
    if (scope.getAttribute && scope.getAttribute("data-an") != null) nodes.unshift(scope);
    nodes.forEach(function (node) {
      String(node.getAttribute("data-an") || "").split(/\s+/).forEach(function (what) {
        if (!what) return;
        if (what === "text") {
          var t = node.getAttribute("data-an-text");
          if (t == null) { t = node.textContent; node.setAttribute("data-an-text", t); }
          node.textContent = say(t);
          return;
        }
        var key = "data-an-" + what;
        var v = node.getAttribute(key);
        if (v == null) { v = node.getAttribute(what); if (v == null) return; node.setAttribute(key, v); }
        node.setAttribute(what, say(v));
      });
    });
  }

  function set(n) {
    if (!valid(n)) return false;
    var s = store();
    try { if (s) s.setItem(KEY, n); } catch (e) {}
    if (n === name) return false;
    name = n;
    apply();
    try { root.dispatchEvent(new root.CustomEvent("assistant-name", { detail: { name: n } })); } catch (e) {}
    return true;
  }

  // The same token the page itself uses: injected by the native window (its own frame, or the Desk's
  // when the phone's front is opened over it), else the browser's stored one.
  function token() {
    try { if (root.__MC_TOKEN__) return root.__MC_TOKEN__; } catch (e) {}
    try { if (root.parent && root.parent !== root && root.parent.__MC_TOKEN__) return root.parent.__MC_TOKEN__; } catch (e) {}
    var s = store();
    try { return (s && s.getItem("mc-token")) || null; } catch (e) { return null; }
  }
  function refresh() {
    var t = token();
    if (!t || !root.fetch) return Promise.resolve(name);
    return root.fetch("/api/assistant", { headers: { "x-mc-admin": t } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.name) set(j.name); return name; })
      .catch(function () { return name; });
  }

  // How a call hears it: the pages' own normalisation (lower case, no accents, words only).
  function fold(s) {
    return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  }
  function words() {
    var n = fold(name);
    return !n || n === "robert" ? "robert" : "robert|" + n;
  }
  function command(w, lead) {
    var key = null, re = null;
    return {
      test: function (n) {
        var k = words();
        if (k !== key) { key = k; re = new RegExp("^ (" + w + "|(?:" + lead + ") (?:" + k + ")) $"); }
        return re.test(n);
      },
    };
  }

  root.AssistantName = {
    DEFAULT: DEFAULT,
    get: function () { return name; },
    say: say, apply: apply, set: set, refresh: refresh, valid: valid, words: words, command: command,
  };

  var doc = root.document;
  if (doc && doc.addEventListener) {
    if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { apply(); });
    else apply();
    refresh();
  }
})(typeof window !== "undefined" ? window : this);

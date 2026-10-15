/* The Chronos SDK INSIDE an artifact page — `window.chronos`.
 *
 * The daemon inlines this file into every artifact it frames (src/artifacts.ts → frameHtml), after
 * `window.__CHRONOS__` = the page's context. The page runs in a sandboxed iframe with an opaque origin
 * and `connect-src 'none'`: it cannot reach the daemon, the Desk's token or anything else. Its ONE way
 * out is postMessage to the viewer (static/artifact-view.js), which checks the message came from this
 * frame and makes the call itself.
 *
 *   chronos.context            { id, title, version, status, question, options, answer, workspace, by }
 *   chronos.submit(data)       the answer — reaches the agent that published the page (resumes it when
 *                              it is waiting on `mc artifact ask`). Once: the page is then answered.
 *   chronos.answer(data)       same as submit
 *   chronos.send(data)         anything short of the answer (a pick, a draft); the agent reads it
 *                              with `mc artifact events <id>`. As many as you like.
 *   chronos.state.get()        the page's saved JSON (survives reloads, other devices)
 *   chronos.state.set(obj)     save it
 *   chronos.on(name, fn)       "answered" (after a submit), "theme"
 *   chronos.close()            close the viewer
 *
 * No code needed for the common cases:
 *   <button data-chronos-submit='{"pick":"B"}'>B</button>     submit that JSON (or the button's text)
 *   <button data-chronos-send="liked">👍</button>              send it
 *   <form data-chronos-submit> … </form>                        submit the form's fields as an object
 */
(function () {
  "use strict";
  var C = window.__CHRONOS__ || {};
  var seq = 0;
  var pending = {};
  var listeners = {};
  var state = C.state === undefined ? null : C.state;

  function emit(name, data) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try { fn(data); } catch (e) { console.error("[chronos]", e); }
    });
  }

  function call(type, data) {
    return new Promise(function (resolve, reject) {
      if (window.parent === window) return reject(new Error("chronos: this page is not open in the Desk"));
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () {
        if (!pending[id]) return;
        delete pending[id];
        reject(new Error("chronos: the Desk did not answer"));
      }, 30000);
      window.parent.postMessage({ __chronos: 1, id: id, type: type, data: data === undefined ? null : data }, "*");
    });
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.__chronos !== 1) return;
    if (m.re) {
      var p = pending[m.re];
      if (!p) return;
      delete pending[m.re];
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || "chronos: failed"));
      return;
    }
    if (m.type === "theme") {
      document.documentElement.setAttribute("data-theme", m.data === "dark" ? "dark" : "light");
      emit("theme", m.data);
    }
  });

  function markAnswered(data) {
    chronos.context.status = "answered";
    chronos.context.answer = data;
    document.documentElement.setAttribute("data-chronos-status", "answered");
    emit("answered", data);
  }

  var chronos = {
    context: {
      id: C.id || null,
      title: C.title || "",
      version: C.version || 1,
      status: C.status || "open",
      question: C.question || null,
      options: C.options || [],
      answer: C.answer === undefined ? null : C.answer,
      workspace: C.workspace || null,
      by: C.by || null,
    },
    submit: function (data) {
      return call("submit", data).then(function (r) { markAnswered(data); return r; });
    },
    send: function (data) { return call("send", data); },
    state: {
      get: function () { return state; },
      set: function (v) { state = v === undefined ? null : v; return call("state", state); },
    },
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return function () { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); };
    },
    close: function () { return call("close", null); },
  };
  chronos.answer = chronos.submit;

  function valueOf(el, kind) {
    var raw = el.getAttribute("data-chronos-" + kind);
    if (raw == null || raw === "") return el.value || (el.textContent || "").trim();
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }
  function formObject(form, submitter) {
    var out = {};
    new FormData(form).forEach(function (v, k) {
      var val = typeof v === "string" ? v : v && v.name ? v.name : "";
      if (Object.prototype.hasOwnProperty.call(out, k)) out[k] = [].concat(out[k], val);
      else out[k] = val;
    });
    if (submitter && submitter.name) out[submitter.name] = submitter.value;
    return out;
  }
  function fail(e) { console.error("[chronos]", e && e.message ? e.message : e); }

  document.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-chronos-submit],[data-chronos-send]") : null;
    if (!el || el.tagName === "FORM") return;
    if (el.form && (el.form.hasAttribute("data-chronos-submit") || el.form.hasAttribute("data-chronos-send"))) return;
    e.preventDefault();
    var kind = el.hasAttribute("data-chronos-submit") ? "submit" : "send";
    chronos[kind](valueOf(el, kind)).catch(fail);
  });
  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute) return;
    var kind = f.hasAttribute("data-chronos-send") ? "send" : f.hasAttribute("data-chronos-submit") ? "submit" : null;
    if (!kind) return;
    e.preventDefault();
    chronos[kind](formObject(f, e.submitter)).catch(fail);
  });

  if (chronos.context.status !== "open") document.documentElement.setAttribute("data-chronos-status", chronos.context.status);
  window.chronos = chronos;
})();

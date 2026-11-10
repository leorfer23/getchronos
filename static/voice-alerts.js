/* Stuck-work alerts on a live voice call — THE CLIENT CONTRACT, for any page that runs a call (the Desk
 * today, the phone's hands-free call next). The daemon side is src/stuck-alerts.ts; a page needs only this.
 *
 * 1. Say you have a call up.  POST /api/voice/presence  (header x-mc-admin: <admin token>)
 *      body { client, surface, live, lang, lock }
 *        client   string ≤80, unique per page load (e.g. "phone-" + random). The same id goes in step 3.
 *        surface  "desk" | "phone" | … — shown in GET /api/alerts.
 *        live     true while the call is up; send false ONCE when it hangs up.
 *        lang     "en" | "es" — the language alerts are spoken in on this call.
 *        lock     the workspace id this page is locked to (the Desk's client lock), or null.
 *      Cadence: once when the call starts, then every 20s, then live:false on hang-up. A page that stops
 *      pinging falls out after 90s and alerts go to the phone instead (the safe direction).
 *
 * 2. Speak what you are handed.  Bus event (WebSocket /ws?token=…&topics=alert.raised):
 *      { topic: "alert.raised", alert_id, workspace_id, session_id, kind, say, lang, client }
 *        say     the words to speak: ≤ 2 sentences, plain text, already in `lang`.
 *        client  the ONE call picked to say it — ignore the event unless it equals your client id.
 *      Speak it ahead of anything queued (after the sentence playing now). Drop it when your call is not
 *      live, or when a client lock passes it no workspace match (static/desk-scope.js passes()).
 *
 * 3. Report what happened.  POST /api/alerts/<alert_id>/spoken  body { client, stage }
 *        stage "started"  the audio for it began playing → the daemon waits up to 60s for "done".
 *        stage "done"     it played to the end → delivered by voice; the phone is not buzzed.
 *      Report NOTHING if the speech could not be rendered (/api/speak failed), playback errored, or it
 *      was skipped / talked over: within 15s (alerts.voice_confirm_sec) the alert goes to the phone.
 *      Never report "done" before it was heard — that is what keeps "delivered" honest.
 *
 * 4. The phone push for the same alert (static/sw.js shows it): payload
 *      { kind: "alert", title, body, tag, url, session_id?, actions, alert_id, at }
 *        url       where a tap lands: "/phone#s=<session id>" (that terminal) or "/phone".
 *        actions   ≤2 buttons, each { action, title, input } — input is a POST /api/sessions/<id>/input
 *                  body the worker types with no app open ({} = just open).
 *        alert_id  any tap → POST /api/alerts/<alert_id>/ack { via: "push_open" | "push_button" }: he has it.
 *      There is no `needs` (badge count) on an alert payload: leave the badge as it is.
 *
 * This file is the reusable half of 1–3: VoiceAlerts.create({ client, surface, post, lang, lock }).
 * Tested in src/voice-alerts.test.ts (run in a vm, like desk-scope.js).
 */
(function (root) {
  function create(o) {
    var timer = 0;
    var post = function (p, body) {
      try { return Promise.resolve(o.post(p, body)).catch(function () {}); } catch (x) { return Promise.resolve(); }
    };
    return {
      /** Step 1: the call is up (on=true: ping now and every `every` ms) or it hung up (on=false: say so once). */
      presence: function (on) {
        if (timer) { clearInterval(timer); timer = 0; }
        var ping = function (live) {
          return post("/api/voice/presence", { client: o.client, surface: o.surface, live: live, lang: o.lang(), lock: o.lock() });
        };
        ping(!!on);
        if (on) timer = setInterval(function () { ping(true); }, o.every || 20000);
      },
      /**
       * Step 2: an `alert.raised` this call should say, or null. Returns { say, started(), done() } —
       * call started() when its audio begins and done() only when it played to the end (step 3).
       */
      take: function (e, live) {
        if (!live || !e || e.topic !== "alert.raised" || !e.say || !e.alert_id) return null;
        if (e.client && e.client !== o.client) return null;
        var report = function (stage) {
          return post("/api/alerts/" + encodeURIComponent(e.alert_id) + "/spoken", { client: o.client, stage: stage });
        };
        var s = false, d = false;
        return {
          say: e.say,
          started: function () { if (!s) { s = true; report("started"); } },
          done: function () { if (!d) { d = true; report("done"); } },
        };
      },
    };
  }
  root.VoiceAlerts = { create: create };
})(typeof window !== "undefined" ? window : globalThis);

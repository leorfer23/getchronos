/* Quick actions, as the page sees them — a hand-kept mirror of src/quick-actions.ts.
 *
 * desk.html has no build step and cannot import a TS module, and the daemon needs the same defaults
 * and the same filtering (an empty kv must still produce a footer full of chips). So the list and
 * the rule live in both places, and src/desk-quick-actions.test.ts runs THIS file in a vm and
 * asserts it agrees with the TS one, action for action and case for case. Change one, change both;
 * the test is what notices if you don't.
 *
 * Everything that decides which chips exist is here. desk.html owns only the tokens, the DOM and
 * what a tap does.
 */
(function (root) {
  var QA_PHASES = ["blocked", "decide", "review", "your_turn", "waiting", "working", "stalled", "always"];
  var QA_KINDS = ["text", "approve", "changes", "ask-robert", "kill"];
  var MAX_VISIBLE = 8;
  var MAX_QUICK_ACTIONS = 40;
  var MAX_LABEL = 24;
  var MAX_TEXT = 2000;

  var DEFAULTS = [
    { label: "✓ Approve", text: "Approved, go ahead", kind: "approve", phases: ["review", "decide"], key: null },
    { label: "🔀 Merge", text: "Merge it and close the terminal", kind: "text", phases: ["review"], key: null },
    { label: "🔍 QA pass", text: "Do a QA pass: run the tests, try the happy path and two edge cases, report what broke", kind: "text", phases: ["review"], key: null },
    { label: "✎ Changes", text: "", kind: "changes", phases: ["review"], key: null },
    { label: "▶ Continue", text: "Continue", kind: "text", phases: ["decide", "your_turn"], key: null },
    { label: "🎲 Your call", text: "Use your judgement and continue, don't ask me", kind: "text", phases: ["decide", "your_turn"], key: null },
    { label: "❓ Status", text: "Where are you? One line", kind: "text", phases: ["working", "waiting"], key: null },
    { label: "⏸ Pause", text: "Finish this step and stop", kind: "text", phases: ["working", "waiting"], key: null },
    { label: "📝 Summary", text: "Write the Summary block now", kind: "text", phases: ["working", "waiting"], key: null },
    { label: "↻ Retry", text: "Retry from where you left off", kind: "text", phases: ["blocked", "stalled"], key: null },
    { label: "🤖 Ask Robert", text: "Have a look at this terminal and tell me what you'd do", kind: "ask-robert", phases: ["blocked", "stalled"], key: null },
    { label: "⏹ Kill", text: "", kind: "kill", phases: ["blocked", "stalled"], key: null },
    { label: "▶ Continue", text: "Continue", kind: "text", phases: ["always"], key: null },
    { label: "🤖 Ask Robert", text: "Have a look at this terminal and tell me what you'd do", kind: "ask-robert", phases: ["always"], key: null },
  ];

  /** A fresh copy — the dialog edits it in place. */
  function defaults() {
    return DEFAULTS.map(function (a) { return { label: a.label, text: a.text, kind: a.kind, phases: a.phases.slice(), key: a.key }; });
  }

  /**
   * The chips for one terminal, in order, with their ⌥ numbers resolved. Own phases plus "always",
   * one chip per label, nothing at all once a terminal has ended (the footer offers ↻ Reopen there).
   * `hasPrompt` never changes WHICH chips show — only whether the approve chip answers the prompt.
   */
  function visible(actions, phase, hasPrompt) {
    if (!phase || phase === "ended") return [];
    var picked = [], seen = Object.create(null), i;
    var list = actions || [];
    for (i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a || !Array.isArray(a.phases)) continue;
      if (a.phases.indexOf(phase) < 0 && a.phases.indexOf("always") < 0) continue;
      var key = String(a.label == null ? "" : a.label).trim().toLowerCase();
      if (!key || seen[key]) continue;
      seen[key] = true;
      picked.push(a);
      if (picked.length >= MAX_VISIBLE) break;
    }
    // Pinned numbers first, so a chip that says ⌥2 keeps saying ⌥2 whatever else is on the row; the
    // rest fill the gaps left over. First pin wins a contested number — two chips cannot share one.
    var taken = Object.create(null), pinned = Object.create(null);
    picked.forEach(function (a, k) {
      var n = Number(a.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && !taken[n]) { taken[n] = true; pinned[k] = n; }
    });
    var next = 1;
    return picked.map(function (a, k) {
      var n = pinned[k] === undefined ? null : pinned[k];
      if (n === null) {
        while (next <= 9 && taken[next]) next++;
        if (next <= 9) { n = next; taken[next] = true; }
      }
      return {
        label: a.label, text: a.text, kind: a.kind || "text", phases: a.phases.slice(), key: a.key === undefined ? null : a.key,
        n: n, smart: a.kind === "approve" && !!hasPrompt,
      };
    });
  }

  root.QuickActions = {
    PHASES: QA_PHASES,
    KINDS: QA_KINDS,
    MAX_VISIBLE: MAX_VISIBLE,
    MAX_ACTIONS: MAX_QUICK_ACTIONS,
    MAX_LABEL: MAX_LABEL,
    MAX_TEXT: MAX_TEXT,
    DEFAULTS: DEFAULTS,
    defaults: defaults,
    visible: visible,
  };
})(typeof window !== "undefined" ? window : globalThis);

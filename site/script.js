(function () {
  'use strict';

  var WINDOW_START_MIN = 23 * 60 + 40;
  var WINDOW_END_MIN = 7 * 60 + 30;
  var SCRUB_MAX = 470;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function minuteToClock(min) {
    var total = (WINDOW_START_MIN + min) % (24 * 60);
    var h = Math.floor(total / 60);
    var m = total % 60;
    return pad(h) + ':' + pad(m);
  }

  function sceneForMinute(min) {
    if (min < 40) return 'dusk';
    if (min < 260) return 'deep-night';
    if (min < 400) return 'pre-dawn';
    return 'dawn';
  }

  var SCENE_LABEL = {
    dusk: 'dusk',
    'deep-night': 'deep night',
    'pre-dawn': 'pre-dawn',
    dawn: 'dawn',
  };

  function realMinuteInWindow() {
    var now = new Date();
    var rm = now.getHours() * 60 + now.getMinutes();
    if (rm >= WINDOW_START_MIN) return rm - WINDOW_START_MIN;
    if (rm <= WINDOW_END_MIN) return rm + (24 * 60 - WINDOW_START_MIN);
    return null;
  }

  var scrubber = document.getElementById('scrubber');
  var clockValues = Array.prototype.slice.call(document.querySelectorAll('.clock-value'));
  var sceneLabels = Array.prototype.slice.call(document.querySelectorAll('.scene-label'));
  var localLine = document.getElementById('localTimeLine');
  var logEntries = Array.prototype.slice.call(document.querySelectorAll('.log-entry[data-time]'));
  var deskCards = Array.prototype.slice.call(document.querySelectorAll('.desk-card[data-timeline]'));
  var logRailMascot = document.querySelector('.log-rail-mascot');
  var logListEl = document.querySelector('.log-list');
  var nightLogWrap = document.querySelector('.night-log-wrap');
  var html = document.documentElement;

  var RATE = {
    working: { haiku: 0.01, sonnet: 0.028, opus: 0.06 },
    review: { haiku: 0.008, sonnet: 0.018, opus: 0.075 },
  };

  var deskTimelines = deskCards.map(function (card) {
    var steps = [];
    try {
      steps = JSON.parse(card.getAttribute('data-timeline') || '[]');
    } catch (e) {
      steps = [];
    }
    return {
      card: card,
      steps: steps,
      nameEl: card.querySelector('.desk-card-name'),
      modelEl: card.querySelector('.desk-card-model'),
      stateTextEl: card.querySelector('.state-text'),
      lineEl: card.querySelector('.desk-card-line'),
      elapsedEl: card.querySelector('.desk-elapsed'),
      costEl: card.querySelector('.desk-cost'),
    };
  });

  function stateLabel(state) {
    switch (state) {
      case 'working': return 'working';
      case 'stalled': return 'stalled — filed a card';
      case 'waiting': return 'waiting on you';
      case 'review': return 'in review';
      case 'done': return 'PR open';
      default: return 'idle';
    }
  }

  function cardMetrics(steps, min) {
    var state = 'idle';
    var model = '';
    var line = '—';
    var stateStart = 0;
    var cost = 0;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (min < step.at) break;
      var segEnd = i + 1 < steps.length && steps[i + 1].at <= min ? steps[i + 1].at : min;
      var segMinutes = Math.max(0, segEnd - step.at);
      var rateTable = RATE[step.state];
      var rate = (rateTable && rateTable[step.model]) || 0;
      cost += segMinutes * rate;
      state = step.state;
      model = step.model;
      line = step.line;
      stateStart = step.at;
    }
    return { state: state, model: model, line: line, elapsed: Math.max(0, min - stateStart), cost: cost };
  }

  function applyDeskState(min) {
    deskTimelines.forEach(function (entry) {
      if (!entry.steps.length) return;
      var m = cardMetrics(entry.steps, min);
      entry.card.setAttribute('data-state', m.state);
      if (entry.stateTextEl) entry.stateTextEl.textContent = stateLabel(m.state);
      if (entry.modelEl) entry.modelEl.textContent = m.state === 'idle' ? '—' : m.model;
      if (entry.lineEl) entry.lineEl.textContent = m.state === 'idle' ? '—' : m.line;
      if (entry.elapsedEl) entry.elapsedEl.textContent = m.state === 'idle' ? '0m' : m.elapsed + 'm';
      if (entry.costEl) entry.costEl.textContent = '$' + m.cost.toFixed(2);
    });
  }

  function applyLogActive(min) {
    var lastPassed = null;
    logEntries.forEach(function (entry) {
      var t = Number(entry.getAttribute('data-time'));
      var passed = min >= t;
      entry.setAttribute('data-active', 'false');
      if (passed) lastPassed = entry;
    });
    if (lastPassed) lastPassed.setAttribute('data-active', 'true');
  }

  var wasInFlipZone = false;
  var lastMinute = 0;

  function setMinute(min, opts) {
    min = Math.max(0, Math.min(SCRUB_MAX, min));
    lastMinute = min;
    var scene = sceneForMinute(min);
    html.setAttribute('data-scene', scene);
    if (scrubber && Number(scrubber.value) !== min) scrubber.value = String(min);
    if (clockValues.length) {
      var clockText = minuteToClock(min);
      clockValues.forEach(function (el) {
        el.textContent = clockText;
        el.setAttribute('data-text', clockText);
      });
    }
    sceneLabels.forEach(function (el) {
      el.textContent = SCENE_LABEL[scene];
    });
    applyDeskState(min);
    applyLogActive(min);

    var p = min / SCRUB_MAX;
    html.style.setProperty('--sand', p.toFixed(3));

    if (logRailMascot && logListEl) {
      var travel = Math.max(0, logListEl.offsetHeight - logRailMascot.offsetHeight);
      logRailMascot.style.top = (p * travel) + 'px';
    }

    var tired = min >= 200 && min <= 220;
    var mascots = document.querySelectorAll('.mascot');
    mascots.forEach(function (m) {
      m.classList.toggle('mascot--tired', tired && !(opts && opts.silent));
    });

    var inFlipZone = min >= 318 && min <= 326;
    if (inFlipZone && !wasInFlipZone && !(opts && opts.silent)) {
      mascots.forEach(function (m) {
        m.classList.remove('mascot--flip');
        void m.offsetWidth;
        m.classList.add('mascot--flip');
      });
    }
    wasInFlipZone = inFlipZone;
  }

  function playRange() {
    if (!nightLogWrap) return null;
    var rect = nightLogWrap.getBoundingClientRect();
    var vh = window.innerHeight;
    var playStart = vh * 0.5;
    var playEnd = playStart - (rect.height - vh * 0.4);
    if (playEnd >= playStart) playEnd = playStart - 1;
    return { top: rect.top, playStart: playStart, playEnd: playEnd };
  }

  function progressToScrollTop(p) {
    var range = playRange();
    if (!range || !nightLogWrap) return null;
    var docTop = nightLogWrap.getBoundingClientRect().top + window.scrollY;
    var desiredViewportTop = range.playStart - p * (range.playStart - range.playEnd);
    return docTop - desiredViewportTop;
  }

  var scrollRAF = null;
  function onScroll() {
    if (scrollRAF) return;
    scrollRAF = requestAnimationFrame(function () {
      scrollRAF = null;
      var range = playRange();
      if (!range) return;
      var p = (range.playStart - range.top) / (range.playStart - range.playEnd);
      p = Math.max(0, Math.min(1, p));
      setMinute(Math.round(p * SCRUB_MAX));
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  function initLocalTime() {
    var rm = realMinuteInWindow();
    if (localLine) {
      if (rm !== null) {
        localLine.textContent = "It's " + minuteToClock(rm) + " where you are right now — good, this is when it matters. The night below starts at dusk regardless; drag or scroll to live through it.";
      } else {
        localLine.textContent = 'A local daemon that runs AI coding agents unattended, and supervises them like a team.';
      }
    }
    setMinute(0, { silent: true });
  }

  if (scrubber) {
    scrubber.setAttribute('max', String(SCRUB_MAX));
    scrubber.addEventListener('input', function () {
      var min = Number(scrubber.value);
      setMinute(min);
      var target = progressToScrollTop(min / SCRUB_MAX);
      if (target !== null) window.scrollTo({ top: target, behavior: 'auto' });
    });
  }

  function jumpTo(min) {
    setMinute(min);
    var target = progressToScrollTop(min / SCRUB_MAX);
    if (target !== null) window.scrollTo({ top: target, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  var jump3am = document.getElementById('jump3am');
  if (jump3am) {
    jump3am.addEventListener('click', function () {
      jumpTo(207);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== '3') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    jumpTo(207);
  });

  var groundToggle = document.getElementById('groundToggle');
  if (groundToggle) {
    groundToggle.addEventListener('click', function () {
      var toPaper = html.getAttribute('data-scene') !== 'dawn';
      jumpTo(toPaper ? 460 : 20);
      var label = toPaper ? 'Paper' : 'Ink';
      groundToggle.querySelector('.ground-toggle-label').textContent = label;
      groundToggle.setAttribute('aria-label', 'Switch to ' + (toPaper ? 'ink' : 'paper') + ' ground (currently ' + label + ')');
    });
  }

  document.querySelectorAll('.copy-btn[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      var done = function () {
        var original = btn.textContent;
        btn.setAttribute('data-copied', 'true');
        btn.textContent = 'copied';
        setTimeout(function () {
          btn.removeAttribute('data-copied');
          btn.textContent = original;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, done);
      } else {
        done();
      }
    });
  });

  var mascotInstance = 0;
  document.querySelectorAll('.mascot[data-mascot-src]').forEach(function (el) {
    var src = el.getAttribute('data-mascot-src');
    fetch(src)
      .then(function (res) {
        if (!res.ok) throw new Error('missing');
        return res.text();
      })
      .then(function (svgText) {
        if (svgText.indexOf('<svg') === -1) throw new Error('invalid');
        mascotInstance += 1;
        var suffix = '-m' + mascotInstance;
        var ids = [];
        svgText = svgText.replace(/id="([^"]+)"/g, function (m, id) {
          ids.push(id);
          return 'id="' + id + suffix + '"';
        });
        ids.forEach(function (id) {
          // Covers url(#id), href="#id" AND bare CSS "#id{...}" selectors an
          // embedded <style> block may use (e.g. the mascot's self-animation
          // rules) — all share the literal "#id" substring, so one pass does it.
          var esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var re = new RegExp('#' + esc + '(?![\\w-])', 'g');
          svgText = svgText.replace(re, '#' + id + suffix);
        });
        el.innerHTML = svgText;
        el.classList.add('mascot--loaded');
      })
      .catch(function () {});
  });

  if (reduceMotion) {
    window.removeEventListener('scroll', onScroll);
    var rm2 = realMinuteInWindow();
    if (localLine) {
      localLine.textContent =
        rm2 !== null
          ? "It's " + minuteToClock(rm2) + ' where you are right now.'
          : 'A local daemon that runs AI coding agents unattended, and supervises them like a team.';
    }
    setMinute(rm2 !== null ? rm2 : 207, { silent: true });
  } else {
    initLocalTime();
  }
})();

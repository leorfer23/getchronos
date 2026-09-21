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

  function realMinuteInWindow() {
    var now = new Date();
    var rm = now.getHours() * 60 + now.getMinutes();
    if (rm >= WINDOW_START_MIN) return rm - WINDOW_START_MIN;
    if (rm <= WINDOW_END_MIN) return rm + (24 * 60 - WINDOW_START_MIN);
    return null;
  }

  var scrubber = document.getElementById('scrubber');
  var clockValue = document.getElementById('clockValue');
  var localLine = document.getElementById('localTimeLine');
  var logEntries = Array.prototype.slice.call(document.querySelectorAll('.log-entry[data-time]'));
  var deskCards = Array.prototype.slice.call(document.querySelectorAll('.desk-card[data-timeline]'));
  var html = document.documentElement;

  var deskTimelines = deskCards.map(function (card) {
    var raw = card.getAttribute('data-timeline') || '';
    var steps = raw.split(';').filter(Boolean).map(function (chunk) {
      var parts = chunk.split(':');
      return { at: Number(parts[0]), state: parts[1] };
    });
    return { card: card, steps: steps };
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

  function applyDeskState(min) {
    deskTimelines.forEach(function (entry) {
      var current = 'idle';
      entry.steps.forEach(function (step) {
        if (min >= step.at) current = step.state;
      });
      entry.card.setAttribute('data-state', current);
      var stateEl = entry.card.querySelector('.desk-card-state .state-text');
      if (stateEl) stateEl.textContent = stateLabel(current);
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

  function setMinute(min, opts) {
    min = Math.max(0, Math.min(SCRUB_MAX, min));
    var scene = sceneForMinute(min);
    html.setAttribute('data-scene', scene);
    if (scrubber && Number(scrubber.value) !== min) scrubber.value = String(min);
    if (clockValue) clockValue.textContent = minuteToClock(min);
    applyDeskState(min);
    applyLogActive(min);

    var sandLevel = min / SCRUB_MAX;
    html.style.setProperty('--sand', sandLevel.toFixed(3));

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

  function initLocalTime() {
    var rm = realMinuteInWindow();
    if (rm !== null) {
      if (localLine) {
        localLine.textContent = 'It is ' + minuteToClock(rm) + ' where you are. Good — this is when it matters.';
      }
      setMinute(rm);
    } else {
      if (localLine) {
        localLine.textContent = "Somewhere right now it's 03:07 and Chronos is mid-shift. Drag the clock to see the rest of the night.";
      }
      setMinute(207);
    }
  }

  if (scrubber) {
    scrubber.setAttribute('max', String(SCRUB_MAX));
    scrubber.addEventListener('input', function () {
      setMinute(Number(scrubber.value));
    });
  }

  var jump3am = document.getElementById('jump3am');
  if (jump3am) {
    jump3am.addEventListener('click', function () {
      setMinute(207);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== '3') return;
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    setMinute(207);
  });

  var groundToggle = document.getElementById('groundToggle');
  if (groundToggle) {
    groundToggle.addEventListener('click', function () {
      var current = html.getAttribute('data-scene');
      var toPaper = current !== 'dawn';
      setMinute(toPaper ? 460 : 100);
      var label = toPaper ? 'Paper' : 'Ink';
      groundToggle.querySelector('.ground-toggle-label').textContent = label;
      groundToggle.setAttribute('aria-label', 'Switch to ' + (toPaper ? 'ink' : 'paper') + ' ground (currently ' + label + ')');
    });
  }

  if (!reduceMotion && logEntries.length && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var t = Number(entry.target.getAttribute('data-time'));
            setMinute(t, { silent: true });
          }
        });
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
    );
    logEntries.forEach(function (entry) {
      observer.observe(entry);
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
          var re = new RegExp('(url\\(#' + id + '\\)|href="#' + id + '")', 'g');
          svgText = svgText.replace(re, function (m) {
            return m.indexOf('url(') === 0 ? 'url(#' + id + suffix + ')' : 'href="#' + id + suffix + '"';
          });
        });
        el.innerHTML = svgText;
        el.classList.add('mascot--loaded');
      })
      .catch(function () {});
  });

  if (reduceMotion) {
    var rm2 = realMinuteInWindow();
    setMinute(rm2 !== null ? rm2 : 207, { silent: true });
  } else {
    initLocalTime();
  }
})();

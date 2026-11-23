/* FRAMES BASEMENT REWARDS - public claim page */
(function () {
  'use strict';

  var form = document.getElementById('claim-form');
  var codeInput = document.getElementById('code');
  var userInput = document.getElementById('username');
  var confirmInput = document.getElementById('confirm');
  var submitButton = document.getElementById('claim-button');
  var resultBox = document.getElementById('claim-result');
  var statReward = document.getElementById('stat-reward');
  var statRemaining = document.getElementById('stat-remaining');
  var statMeter = document.getElementById('stat-meter');
  var statNext = document.getElementById('stat-next');
  var statNextHint = document.getElementById('stat-next-hint');
  var todayDate = document.getElementById('today-date');
  var todayNotice = document.getElementById('today-notice');

  var USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;
  var countdownTimer = null;
  var countdownTarget = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function api(path, options) {
    var config = options || {};
    config.headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
    return fetch(path, config).then(function (response) {
      return response
        .json()
        .catch(function () {
          return { ok: false, error: { message: 'Unexpected response from the server.' } };
        })
        .then(function (data) {
          return { status: response.status, data: data };
        });
    });
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function formatCountdown(msRemaining) {
    var total = Math.max(0, Math.floor(msRemaining / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    return hours + 'h ' + String(minutes).padStart(2, '0') + 'm ' + String(seconds).padStart(2, '0') + 's';
  }

  function startCountdown(node) {
    stopCountdown();
    countdownTarget = Date.now() + Number(node.dataset.remainingMs || 0);
    var tick = function () {
      var left = countdownTarget - Date.now();
      if (left <= 0) {
        node.textContent = 'Available now — try claiming again.';
        stopCountdown();
        return;
      }
      node.textContent = formatCountdown(left);
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  function renderResult(kind, title, lines) {
    stopCountdown();
    resultBox.className = 'result is-' + kind;
    resultBox.hidden = false;
    resultBox.textContent = '';
    resultBox.appendChild(el('h3', null, title));

    (lines || []).forEach(function (line) {
      if (!line) return;
      if (line.type === 'time') {
        var time = el('span', 'result-time', line.text);
        resultBox.appendChild(time);
        if (line.countdown) {
          var countdown = el('p', 'result-detail');
          countdown.appendChild(document.createTextNode('Unlocks in '));
          var live = el('span', 'countdown', '');
          live.dataset.remainingMs = String(line.remainingMs || 0);
          countdown.appendChild(live);
          resultBox.appendChild(countdown);
          startCountdown(live);
        }
        return;
      }
      resultBox.appendChild(el('p', line.type === 'detail' ? 'result-detail' : null, line.text));
    });
  }

  function setFieldError(input, invalid) {
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function renderToday(today) {
    if (!today) return;
    todayDate.textContent =
      today.weekday + ', ' + today.date_label + ' · resets at midnight (' + today.timezone + ')';
    statReward.textContent = today.has_promo ? today.reward : 'No active code';
    statRemaining.textContent = today.has_promo
      ? String(today.remaining) + ' / ' + today.max_claims
      : '0 / 0';

    var percent = today.max_claims > 0 ? Math.round((today.remaining / today.max_claims) * 100) : 0;
    statMeter.value = percent;
    statMeter.setAttribute('value', String(percent));

    var next = today.next_switch_at ? new Date(today.next_switch_at) : null;
    statNext.textContent = next
      ? next.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE }) + ' ET'
      : 'Midnight ET';
    statNextHint.textContent = today.next_switch_at_local || 'midnight ' + today.timezone;

    if (!today.has_promo) {
      todayNotice.hidden = false;
      todayNotice.textContent =
        'No promo code is scheduled for ' +
        today.date_label +
        '. Staff may add one at any time — check the Discord announcements.';
    } else if (today.remaining === 0) {
      todayNotice.hidden = false;
      todayNotice.textContent =
        'Today’s code has reached its maximum of ' + today.max_claims + ' claims. A new code drops at midnight.';
    } else {
      todayNotice.hidden = true;
      todayNotice.textContent = '';
    }
  }

  function loadToday() {
    return api('/api/public/config')
      .then(function (response) {
        if (response.data && response.data.today) {
          renderToday(response.data.today);
        }
      })
      .catch(function () {
        todayNotice.hidden = false;
        todayNotice.textContent = 'Could not reach the reward server. Check your connection and refresh.';
      });
  }

  function validate() {
    var problems = [];
    var code = codeInput.value.trim();
    var username = userInput.value.trim();
    var confirm = confirmInput.value.trim();

    setFieldError(codeInput, !code);
    if (!code) problems.push({ input: codeInput, message: 'Enter the promo code from today’s announcement.' });

    var badUser = !USERNAME_PATTERN.test(username);
    setFieldError(userInput, badUser);
    if (badUser) {
      problems.push({
        input: userInput,
        message: 'Minecraft usernames are 3-16 characters using letters, numbers or underscores.',
      });
    }

    var badConfirm = confirm.length === 0 || confirm.toLowerCase() !== username.toLowerCase();
    setFieldError(confirmInput, badConfirm);
    if (badConfirm) {
      problems.push({ input: confirmInput, message: 'The two Minecraft usernames must match exactly.' });
    }

    return problems;
  }

  function handleSubmit(event) {
    event.preventDefault();
    var problems = validate();
    if (problems.length > 0) {
      renderResult('error', 'CHECK YOUR DETAILS', [
        { text: problems[0].message },
        { type: 'detail', text: 'Nothing was sent to the server yet.' },
      ]);
      problems[0].input.focus();
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'CHECKING…';

    api('/api/public/claim', {
      method: 'POST',
      body: JSON.stringify({
        code: codeInput.value.trim(),
        username: userInput.value.trim(),
        confirmUsername: confirmInput.value.trim(),
      }),
    })
      .then(function (response) {
        var data = response.data || {};
        if (data.ok) {
          var claim = data.claim || {};
          renderResult('success', 'REWARD CLAIMED', [
            { text: data.message || 'Your reward has been claimed! Delivery may take up to 3 days.' },
            {
              type: 'detail',
              text:
                'Minecraft username: ' +
                (claim.username || '—') +
                ' · Reward: ' +
                (claim.reward || '—') +
                ' · Claim #' +
                (claim.id || '—'),
            },
            {
              type: 'detail',
              text: 'Claimed ' + (claim.claimed_at_local || '') + '. Next claim unlocks ' + (data.next_claim_at_local || '') + '.',
            },
          ]);
          if (data.today) renderToday(data.today);
          try {
            localStorage.setItem('fb_last_username', claim.username || '');
          } catch (error) {
            /* storage may be blocked */
          }
          form.reset();
          return;
        }

        var error = data.error || {};
        if (error.code === 'COOLDOWN') {
          renderResult('warn', '24-HOUR COOLDOWN ACTIVE', [
            { text: error.message },
            { type: 'detail', text: 'This username can claim again at exactly:' },
            {
              type: 'time',
              text: error.unavailable_until_local || error.unavailable_until,
              countdown: true,
              remainingMs: Number(error.seconds_remaining || 0) * 1000,
            },
            {
              type: 'detail',
              text: 'Last claim: ' + (error.last_claim_at_local || 'earlier today') + '. Cooldowns are stored on our server.',
            },
          ]);
          return;
        }

        if (error.code === 'PROMO_EXHAUSTED') {
          renderResult('warn', 'CODE FULLY CLAIMED', [
            { text: error.message },
            { type: 'detail', text: 'Nothing is lost — a brand new code drops at midnight in America/Toronto.' },
          ]);
          loadToday();
          return;
        }

        renderResult('error', 'CLAIM NOT ACCEPTED', [
          { text: error.message || 'The claim was not accepted. Please try again.' },
          { type: 'detail', text: 'Code: ' + (error.code || 'UNKNOWN') },
        ]);
        loadToday();
      })
      .catch(function () {
        renderResult('error', 'CONNECTION PROBLEM', [
          { text: 'We could not reach the reward server. Check your connection and try again.' },
          { type: 'detail', text: 'Your cooldown is stored on the server, so retrying is always safe.' },
        ]);
      })
      .then(function () {
        submitButton.disabled = false;
        submitButton.textContent = 'CLAIM REWARD';
      });
  }

  form.addEventListener('submit', handleSubmit);

  [codeInput, userInput, confirmInput].forEach(function (input) {
    input.addEventListener('input', function () {
      setFieldError(input, false);
    });
  });

  codeInput.addEventListener('input', function () {
    var cursor = codeInput.selectionStart;
    codeInput.value = codeInput.value.toUpperCase().replace(/\s+/g, '');
    if (typeof cursor === 'number') codeInput.setSelectionRange(cursor, cursor);
  });

  try {
    var remembered = localStorage.getItem('fb_last_username');
    if (remembered && USERNAME_PATTERN.test(remembered)) userInput.value = remembered;
  } catch (error) {
    /* storage may be blocked */
  }

  loadToday();
})();

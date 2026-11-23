/* FRAMES BASEMENT REWARDS - admin panel */
(function () {
  'use strict';

  var state = {
    overview: null,
    promos: [],
    promoFilter: 'all',
    editingId: null,
    claims: { items: [], total: 0, offset: 0, limit: 25, filter: 'all', search: '' },
    authenticated: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function api(path, options) {
    var config = options || {};
    config.headers = Object.assign({ 'Content-Type': 'application/json' }, config.headers || {});
    config.credentials = 'same-origin';
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

  function flash(message, kind) {
    var box = $('flash');
    if (!message) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    box.hidden = false;
    box.className = 'admin-flash ' + (kind === 'bad' ? 'is-bad' : 'is-ok');
    box.textContent = message;
  }

  function showLogin() {
    state.authenticated = false;
    $('login-view').hidden = false;
    $('dashboard-view').hidden = true;
    $('logout-button').hidden = true;
  }

  function showDashboard() {
    state.authenticated = true;
    $('login-view').hidden = true;
    $('dashboard-view').hidden = false;
    $('logout-button').hidden = false;
  }

  // ------------------------------------------------------------------ login
  function checkSession() {
    return api('/api/admin/session').then(function (response) {
      var data = response.data || {};
      $('login-hint').textContent =
        data.password_mode === 'environment'
          ? 'Password is managed by the ADMIN_PASSWORD environment variable.'
          : '';
      if (data.authenticated) {
        showDashboard();
        loadAll();
      } else {
        showLogin();
      }
    });
  }

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var password = $('admin-password').value;
    if (!password) {
      flash('Enter the admin password.', 'bad');
      return;
    }
    var button = $('login-button');
    button.disabled = true;
    button.textContent = 'SIGNING IN…';
    api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: password }) })
      .then(function (response) {
        if (response.data && response.data.ok) {
          $('admin-password').value = '';
          flash('Signed in.', 'ok');
          showDashboard();
          loadAll();
        } else {
          flash((response.data.error && response.data.error.message) || 'Sign in failed.', 'bad');
        }
      })
      .catch(function () {
        flash('Could not reach the server. Try again.', 'bad');
      })
      .then(function () {
        button.disabled = false;
        button.textContent = 'SIGN IN';
      });
  });

  $('logout-button').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST' }).then(function () {
      flash('Signed out.', 'ok');
      showLogin();
    });
  });

  // -------------------------------------------------------------- overview
  function renderOverview(overview) {
    state.overview = overview;
    var today = overview.today;
    $('ov-date').textContent = today.date_label;
    $('ov-weekday').textContent = today.weekday + ' · ' + overview.timezone;
    $('ov-code').textContent = today.code || 'not set';
    $('ov-reward').textContent = today.reward || 'No promo scheduled today';
    $('ov-today-claims').textContent = String(today.claims || 0);
    $('ov-today-remaining').textContent = today.has_promo
      ? String(today.remaining) + ' of ' + today.max_claims + ' left'
      : 'No active code';
    $('ov-total').textContent = String(overview.totals.claims);
    $('ov-pending').textContent =
      overview.totals.pending + ' pending · ' + overview.totals.delivered + ' delivered · ' + overview.totals.usernames + ' players';
    $('password-mode').textContent =
      overview.password_mode === 'environment' ? 'managed by environment variable' : 'stored hashed in database';

    var upcomingList = $('upcoming-list');
    upcomingList.textContent = '';
    overview.upcoming.forEach(function (day) {
      var li = el('li');
      li.appendChild(el('span', null, day.weekday.slice(0, 3) + ' ' + day.date_label));
      var right = el('strong', day.has_promo ? 'mono' : null, day.has_promo ? day.code + ' · ' + day.remaining + ' left' : 'not prepared');
      li.appendChild(right);
      upcomingList.appendChild(li);
    });

    var todayList = $('today-list');
    todayList.textContent = '';
    [
      ['Promo code', today.code || '—'],
      ['Reward', today.reward || '—'],
      ['Claims', String(today.claims || 0) + ' / ' + (today.max_claims || 0)],
      ['Remaining uses', String(today.remaining || 0)],
      ['Next switch', today.next_switch_at_local || '—'],
      ['Server time', new Date(overview.server_time).toLocaleString()],
    ].forEach(function (pair) {
      var li = el('li');
      li.appendChild(el('span', null, pair[0]));
      li.appendChild(el('strong', null, pair[1]));
      todayList.appendChild(li);
    });
  }

  function loadOverview() {
    return api('/api/admin/overview').then(function (response) {
      if (response.status === 401) {
        showLogin();
        return;
      }
      if (response.data && response.data.ok) renderOverview(response.data.overview);
    });
  }

  // ----------------------------------------------------------------- promos
  function statusBadge(status) {
    var map = { today: 'badge-today', upcoming: 'badge-upcoming', past: 'badge-past' };
    return el('span', 'badge ' + (map[status] || ''), status);
  }

  function renderPromos() {
    var rows = $('promo-rows');
    rows.textContent = '';
    var filtered = state.promos.filter(function (promo) {
      if (state.promoFilter === 'all') return true;
      return promo.status === state.promoFilter;
    });

    $('promo-count').textContent = filtered.length + ' of ' + state.promos.length + ' days';
    $('promo-empty').hidden = filtered.length > 0;

    filtered.forEach(function (promo) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', promo.date + ' · ' + promo.weekday.slice(0, 3)));
      var statusCell = el('td');
      statusCell.appendChild(statusBadge(promo.status));
      if (!promo.active) statusCell.appendChild(el('span', 'badge', ' off'));
      tr.appendChild(statusCell);
      tr.appendChild(el('td', 'mono', promo.code));
      tr.appendChild(el('td', null, promo.reward));
      tr.appendChild(el('td', null, String(promo.claims)));
      tr.appendChild(el('td', null, String(promo.remaining) + ' / ' + promo.max_claims));

      var actions = el('td');
      var wrap = el('div', 'row-actions');

      var edit = el('button', 'btn btn-ghost btn-small', 'Edit');
      edit.type = 'button';
      edit.addEventListener('click', function () {
        fillPromoForm(promo);
      });
      wrap.appendChild(edit);

      var toggle = el('button', 'btn btn-ghost btn-small', promo.active ? 'Disable' : 'Enable');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        savePromo({
          id: promo.id,
          date: promo.date,
          code: promo.code,
          reward: promo.reward,
          maxClaims: promo.max_claims,
          active: !promo.active,
          note: promo.note,
        });
      });
      wrap.appendChild(toggle);

      var remove = el('button', 'btn btn-danger btn-small', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        if (!window.confirm('Delete the promo for ' + promo.date + '?')) return;
        api('/api/admin/promos/' + promo.id, { method: 'DELETE' }).then(function (response) {
          if (response.data && response.data.ok) {
            flash('Promo for ' + promo.date + ' deleted.', 'ok');
            loadAll();
          } else {
            flash((response.data.error && response.data.error.message) || 'Could not delete promo.', 'bad');
          }
        });
      });
      wrap.appendChild(remove);

      actions.appendChild(wrap);
      tr.appendChild(actions);
      rows.appendChild(tr);
    });
  }

  function loadPromos() {
    return api('/api/admin/promos').then(function (response) {
      if (response.status === 401) {
        showLogin();
        return;
      }
      if (response.data && response.data.ok) {
        state.promos = response.data.promos;
        renderPromos();
      }
    });
  }

  function fillPromoForm(promo) {
    state.editingId = promo.id || null;
    $('promo-id').value = promo.id || '';
    $('promo-date').value = promo.date || '';
    $('promo-code').value = promo.code || '';
    $('promo-reward').value = promo.reward || '';
    $('promo-max').value = promo.max_claims || 50;
    $('promo-note').value = promo.note || '';
    $('promo-active').checked = promo.active !== false;
    $('promo-form-title').textContent = promo.id ? 'EDIT PROMO · ' + promo.date : 'CREATE DAILY PROMO';
    $('promo-date').focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetPromoForm() {
    state.editingId = null;
    $('promo-form').reset();
    $('promo-id').value = '';
    $('promo-max').value = 50;
    $('promo-active').checked = true;
    $('promo-form-title').textContent = 'CREATE DAILY PROMO';
    if (state.overview) $('promo-date').value = state.overview.today.date;
  }

  function savePromo(payload) {
    var method = payload.id ? 'PUT' : 'POST';
    var url = payload.id ? '/api/admin/promos/' + payload.id : '/api/admin/promos';
    return api(url, { method: method, body: JSON.stringify(payload) }).then(function (response) {
      if (response.data && response.data.ok) {
        flash((payload.id ? 'Saved promo for ' : 'Created promo for ') + response.data.promo.date + '.', 'ok');
        resetPromoForm();
        loadAll();
      } else {
        flash((response.data.error && response.data.error.message) || 'Could not save the promo.', 'bad');
      }
    });
  }

  $('promo-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var id = $('promo-id').value;
    savePromo({
      id: id ? Number(id) : null,
      date: $('promo-date').value,
      code: $('promo-code').value,
      reward: $('promo-reward').value,
      maxClaims: Number($('promo-max').value),
      active: $('promo-active').checked,
      note: $('promo-note').value,
    });
  });

  $('promo-reset').addEventListener('click', resetPromoForm);
  $('promo-fill-today').addEventListener('click', function () {
    if (state.overview) $('promo-date').value = state.overview.today.date;
  });
  $('promo-fill-tomorrow').addEventListener('click', function () {
    if (!state.overview) return;
    var parts = state.overview.today.date.split('-').map(Number);
    var next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1, 12));
    var month = String(next.getUTCMonth() + 1).padStart(2, '0');
    var day = String(next.getUTCDate()).padStart(2, '0');
    $('promo-date').value = next.getUTCFullYear() + '-' + month + '-' + day;
  });
  $('promo-filter').addEventListener('change', function (event) {
    state.promoFilter = event.target.value;
    renderPromos();
  });

  // ----------------------------------------------------------------- claims
  function loadClaims() {
    var params = new URLSearchParams();
    params.set('limit', String(state.claims.limit));
    params.set('offset', String(state.claims.offset));
    if (state.claims.filter !== 'all') params.set('delivered', state.claims.filter);
    if (state.claims.search) params.set('search', state.claims.search);

    return api('/api/admin/claims?' + params.toString()).then(function (response) {
      if (response.status === 401) {
        showLogin();
        return;
      }
      if (!response.data || !response.data.ok) return;
      state.claims.items = response.data.claims;
      state.claims.total = response.data.total;
      renderClaims();
    });
  }

  function renderClaims() {
    var rows = $('claim-rows');
    rows.textContent = '';
    $('claims-empty').hidden = state.claims.items.length > 0;
    $('claims-sub').textContent = state.claims.total + ' claim(s) on record';

    state.claims.items.forEach(function (claim) {
      var tr = el('tr');
      tr.appendChild(el('td', 'mono', '#' + claim.id));
      tr.appendChild(el('td', 'mono', claim.username));
      tr.appendChild(el('td', null, claim.reward));
      tr.appendChild(el('td', 'mono', claim.promo_date_label));
      tr.appendChild(el('td', 'mono', claim.claimed_at_local));
      var status = el('td');
      status.appendChild(
        el('span', 'badge ' + (claim.delivered ? 'badge-delivered' : 'badge-pending'), claim.delivered ? 'delivered' : 'pending'),
      );
      tr.appendChild(status);

      var actions = el('td');
      var wrap = el('div', 'row-actions');
      var toggle = el('button', 'btn btn-ghost btn-small', claim.delivered ? 'Mark pending' : 'Mark delivered');
      toggle.type = 'button';
      toggle.addEventListener('click', function () {
        api('/api/admin/claims/' + claim.id + '/delivered', {
          method: 'POST',
          body: JSON.stringify({ delivered: !claim.delivered }),
        }).then(function (response) {
          if (response.data && response.data.ok) {
            flash('Claim #' + claim.id + ' marked ' + (claim.delivered ? 'pending' : 'delivered') + '.', 'ok');
            loadClaims();
            loadOverview();
          } else {
            flash('Could not update the claim.', 'bad');
          }
        });
      });
      wrap.appendChild(toggle);

      var remove = el('button', 'btn btn-danger btn-small', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        if (!window.confirm('Delete claim #' + claim.id + ' for ' + claim.username + '? The player will be able to claim again.')) return;
        api('/api/admin/claims/' + claim.id, { method: 'DELETE' }).then(function (response) {
          if (response.data && response.data.ok) {
            flash('Claim #' + claim.id + ' deleted.', 'ok');
            loadAll();
          } else {
            flash('Could not delete the claim.', 'bad');
          }
        });
      });
      wrap.appendChild(remove);
      actions.appendChild(wrap);
      tr.appendChild(actions);
      rows.appendChild(tr);
    });

    var from = state.claims.total === 0 ? 0 : state.claims.offset + 1;
    var to = Math.min(state.claims.offset + state.claims.limit, state.claims.total);
    $('claims-range').textContent = 'Showing ' + from + '–' + to + ' of ' + state.claims.total;
    $('claims-prev').disabled = state.claims.offset === 0;
    $('claims-next').disabled = to >= state.claims.total;
  }

  $('claims-filter').addEventListener('change', function (event) {
    state.claims.filter = event.target.value;
    state.claims.offset = 0;
    loadClaims();
  });

  function runSearch() {
    state.claims.search = $('claims-search').value.trim();
    state.claims.offset = 0;
    loadClaims();
  }

  $('claims-search-button').addEventListener('click', runSearch);
  $('claims-search').addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      runSearch();
    }
  });
  $('claims-prev').addEventListener('click', function () {
    state.claims.offset = Math.max(0, state.claims.offset - state.claims.limit);
    loadClaims();
  });
  $('claims-next').addEventListener('click', function () {
    state.claims.offset += state.claims.limit;
    loadClaims();
  });

  // --------------------------------------------------------------- password
  $('password-form').addEventListener('submit', function (event) {
    event.preventDefault();
    api('/api/admin/password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword: $('current-password').value,
        newPassword: $('new-password').value,
      }),
    }).then(function (response) {
      if (response.data && response.data.ok) {
        flash('Password updated. Please sign in again.', 'ok');
        $('password-form').reset();
        showLogin();
      } else {
        flash((response.data.error && response.data.error.message) || 'Could not update the password.', 'bad');
      }
    });
  });

  // ------------------------------------------------------------------ boot
  function loadAll() {
    loadOverview();
    loadPromos();
    loadClaims();
  }

  $('refresh-button').addEventListener('click', function () {
    flash('Refreshed.', 'ok');
    loadAll();
  });

  checkSession().then(function () {
    if (state.authenticated && state.overview) resetPromoForm();
  });
})();

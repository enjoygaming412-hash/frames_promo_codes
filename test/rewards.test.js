import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createApp } from '../server/app.js';

const ADMIN_PASSWORD = 'test-admin-password-1234';
const SUCCESS = 'Your reward has been claimed! Delivery may take up to 3 days.';
const quietLogger = { log() {}, error() {} };

/** Boot a real HTTP server with its own temporary SQLite database. */
async function startServer(t, { clock, adminPassword = ADMIN_PASSWORD } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbr-test-'));
  const dbPath = path.join(dir, 'rewards.db');
  const app = createApp({ dbPath, adminPassword, clock, logger: quietLogger });
  const server = app.listen(0, '0.0.0.0');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = app.locals.store;

  t.after(() => {
    server.closeAllConnections?.();
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { base, store, dbPath };
}

async function request(base, pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function claim(base, payload) {
  return request(base, '/api/public/claim', { method: 'POST', body: payload });
}

async function adminLogin(base, password = ADMIN_PASSWORD) {
  const result = await request(base, '/api/admin/login', { method: 'POST', body: { password } });
  const setCookie = result.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  return { ...result, cookie };
}

describe('FRAMES BASEMENT REWARDS', () => {
  it('serves the public page and today’s promo details', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'FRAMES-TUE', reward: '1x Diamond Kit', maxClaims: 3 });

    const page = await request(base, '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /FRAMES BASEMENT REWARDS/);
    assert.match(page.text, /CLAIM REWARD/);

    const config = await request(base, '/api/public/config');
    assert.equal(config.status, 200);
    assert.equal(config.json.today.date, '2026-03-10');
    assert.equal(config.json.today.timezone, 'America/Toronto');
    assert.equal(config.json.today.has_promo, true);
    assert.equal(config.json.today.reward, '1x Diamond Kit');
    assert.equal(config.json.today.remaining, 3);
    assert.equal(config.json.success_message, SUCCESS);
  });

  it('accepts a valid claim, normalises input and returns the exact success message', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'FRAMES-TUE', reward: '1x Diamond Kit', maxClaims: 3 });

    const result = await claim(base, {
      code: ' frames-tue ',
      username: 'Steve_01',
      confirmUsername: 'steve_01',
    });

    assert.equal(result.status, 201);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.message, SUCCESS);
    assert.equal(result.json.claim.username, 'Steve_01');
    assert.equal(result.json.claim.reward, '1x Diamond Kit');
    assert.equal(result.json.claim.delivered, false);
    assert.equal(result.json.next_claim_at, '2026-03-11T15:00:00.000Z');
    assert.equal(result.json.today.remaining, 2);
    assert.equal(store.listClaims({}).total, 1);
  });

  it('enforces the 24 hour cooldown with an exact unavailable-until time', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'FRAMES-TUE', reward: '1x Diamond Kit', maxClaims: 50 });
    await claim(base, { code: 'FRAMES-TUE', username: 'Alex', confirmUsername: 'Alex' });

    const second = await claim(base, { code: 'FRAMES-TUE', username: 'alex', confirmUsername: 'ALEX' });
    assert.equal(second.status, 429);
    assert.equal(second.json.error.code, 'COOLDOWN');
    assert.equal(second.json.error.unavailable_until, '2026-03-11T15:00:00.000Z');
    assert.equal(
      second.json.error.unavailable_until_local,
      'Wednesday, March 11, 2026 at 11:00 AM EDT',
    );
    assert.equal(second.json.error.seconds_remaining, 86400);
    assert.match(second.json.error.message, /can claim again on Wednesday, March 11, 2026 at 11:00 AM EDT/);

    // Refreshing or reopening the page cannot bypass the rule: the limit lives in the database.
    for (let i = 0; i < 3; i += 1) {
      const retry = await claim(base, { code: 'FRAMES-TUE', username: 'Alex', confirmUsername: 'Alex' });
      assert.equal(retry.status, 429);
    }
    assert.equal(store.listClaims({}).total, 1);

    const status = await request(base, '/api/public/status?username=alex');
    assert.equal(status.json.cooldown.unavailable_until, '2026-03-11T15:00:00.000Z');
  });

  it('allows the same username to claim again once 24 hours have passed', async (t) => {
    let current = new Date('2026-03-10T15:00:00Z');
    const { base, store } = await startServer(t, { clock: () => current });
    store.savePromo({ date: '2026-03-10', code: 'DAY-TEN', reward: 'Day 10 reward', maxClaims: 10 });
    store.savePromo({ date: '2026-03-11', code: 'DAY-ELEVEN', reward: 'Day 11 reward', maxClaims: 10 });

    assert.equal((await claim(base, { code: 'DAY-TEN', username: 'Herobrine', confirmUsername: 'Herobrine' })).status, 201);

    current = new Date('2026-03-11T14:59:00Z');
    const tooSoon = await claim(base, { code: 'DAY-ELEVEN', username: 'Herobrine', confirmUsername: 'Herobrine' });
    assert.equal(tooSoon.status, 429);
    assert.equal(tooSoon.json.error.unavailable_until, '2026-03-11T15:00:00.000Z');

    current = new Date('2026-03-11T15:00:01Z');
    const allowed = await claim(base, { code: 'DAY-ELEVEN', username: 'Herobrine', confirmUsername: 'Herobrine' });
    assert.equal(allowed.status, 201);
    assert.equal(allowed.json.claim.reward, 'Day 11 reward');
  });

  it('stops accepting claims when the daily maximum is reached', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'LIMITED', reward: '1x Iron Kit', maxClaims: 2 });

    assert.equal((await claim(base, { code: 'LIMITED', username: 'Alex', confirmUsername: 'Alex' })).status, 201);
    assert.equal((await claim(base, { code: 'LIMITED', username: 'Ben', confirmUsername: 'Ben' })).status, 201);

    const third = await claim(base, { code: 'LIMITED', username: 'Carl', confirmUsername: 'Carl' });
    assert.equal(third.status, 409);
    assert.equal(third.json.error.code, 'PROMO_EXHAUSTED');
    assert.match(third.json.error.message, /limit of 2 claims/);

    const config = await request(base, '/api/public/config');
    assert.equal(config.json.today.remaining, 0);
    assert.equal(store.listClaims({}).total, 2);
  });

  it('only accepts the current day’s promo code', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-09', code: 'YESTERDAY', reward: 'Old reward', maxClaims: 10 });
    store.savePromo({ date: '2026-03-10', code: 'TODAY', reward: 'Today reward', maxClaims: 10 });
    store.savePromo({ date: '2026-03-11', code: 'TOMORROW', reward: 'Future reward', maxClaims: 10 });

    const future = await claim(base, { code: 'TOMORROW', username: 'Alex', confirmUsername: 'Alex' });
    assert.equal(future.status, 400);
    assert.equal(future.json.error.code, 'INVALID_CODE');

    const past = await claim(base, { code: 'YESTERDAY', username: 'Alex', confirmUsername: 'Alex' });
    assert.equal(past.status, 400);
    assert.equal(past.json.error.code, 'INVALID_CODE');

    const today = await claim(base, { code: 'TODAY', username: 'Alex', confirmUsername: 'Alex' });
    assert.equal(today.status, 201);
    assert.equal(today.json.claim.reward, 'Today reward');
  });

  it('switches to the next daily promo at midnight in America/Toronto', async (t) => {
    let current = new Date('2026-03-11T03:59:00Z'); // Mar 10, 11:59 PM EDT
    const { base, store } = await startServer(t, { clock: () => current });
    store.savePromo({ date: '2026-03-10', code: 'NIGHT', reward: 'Night reward', maxClaims: 10 });
    store.savePromo({ date: '2026-03-11', code: 'DAWN', reward: 'Dawn reward', maxClaims: 10 });

    const beforeMidnight = await request(base, '/api/public/config');
    assert.equal(beforeMidnight.json.today.date, '2026-03-10');
    assert.equal(beforeMidnight.json.today.reward, 'Night reward');
    assert.equal((await claim(base, { code: 'NIGHT', username: 'NightPlayer', confirmUsername: 'NightPlayer' })).status, 201);

    current = new Date('2026-03-11T04:01:00Z'); // Mar 11, 12:01 AM EDT

    const afterMidnight = await request(base, '/api/public/config');
    assert.equal(afterMidnight.json.today.date, '2026-03-11');
    assert.equal(afterMidnight.json.today.reward, 'Dawn reward');
    assert.equal(afterMidnight.json.today.weekday, 'Wednesday');

    const oldCode = await claim(base, { code: 'NIGHT', username: 'DawnPlayer', confirmUsername: 'DawnPlayer' });
    assert.equal(oldCode.status, 400);
    assert.equal(oldCode.json.error.code, 'INVALID_CODE');

    const newCode = await claim(base, { code: 'DAWN', username: 'DawnPlayer', confirmUsername: 'DawnPlayer' });
    assert.equal(newCode.status, 201);
    assert.equal(newCode.json.claim.reward, 'Dawn reward');
  });

  it('validates the submitted usernames before touching the database', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'TODAY', reward: 'Today reward', maxClaims: 10 });

    const mismatch = await claim(base, { code: 'TODAY', username: 'Notch', confirmUsername: 'Notchh' });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.error.code, 'USERNAME_MISMATCH');

    const invalid = await claim(base, { code: 'TODAY', username: 'no spaces!', confirmUsername: 'no spaces!' });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error.code, 'INVALID_USERNAME');

    const noCode = await claim(base, { code: '', username: 'Notch', confirmUsername: 'Notch' });
    assert.equal(noCode.status, 400);
    assert.equal(noCode.json.error.code, 'CODE_REQUIRED');

    assert.equal(store.listClaims({}).total, 0);
  });

  it('keeps duplicate claims out at the database level', async (t) => {
    const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    store.savePromo({ date: '2026-03-10', code: 'TODAY', reward: 'Today reward', maxClaims: 10 });
    await claim(base, { code: 'TODAY', username: 'Alex', confirmUsername: 'Alex' });
    const promo = store.getPromoByDate('2026-03-10');

    assert.throws(
      () =>
        store.db.run(
          `INSERT INTO claims (promo_id, promo_date, code, reward, username, username_lower, claimed_at, claimed_date, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [promo.id, '2026-03-10', 'TODAY', 'Today reward', 'ALEX', 'alex', new Date().toISOString(), '2026-03-10', ''],
        ),
      /UNIQUE/i,
    );
    assert.equal(store.listClaims({}).total, 1);
  });

  it('reports no active promo when the day has no code', async (t) => {
    const { base } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
    const result = await claim(base, { code: 'ANYTHING', username: 'Alex', confirmUsername: 'Alex' });
    assert.equal(result.status, 404);
    assert.equal(result.json.error.code, 'NO_ACTIVE_PROMO');

    const config = await request(base, '/api/public/config');
    assert.equal(config.json.today.has_promo, false);
  });

  describe('admin access', () => {
    it('requires the server-side password and protects every admin endpoint', async (t) => {
      const { base } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });

      assert.equal((await request(base, '/api/admin/promos')).status, 401);
      assert.equal((await request(base, '/api/admin/claims')).status, 401);
      assert.equal((await request(base, '/api/admin/overview')).status, 401);

      const wrong = await adminLogin(base, 'not-the-password');
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error.code, 'BAD_CREDENTIALS');

      const session = await request(base, '/api/admin/session');
      assert.equal(session.json.authenticated, false);
      assert.equal(session.json.password_mode, 'environment');

      const login = await adminLogin(base);
      assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie'), /HttpOnly/);
      assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);

      const authorised = await request(base, '/api/admin/promos', { cookie: login.cookie });
      assert.equal(authorised.status, 200);
      assert.equal(authorised.json.ok, true);

      await request(base, '/api/admin/logout', { method: 'POST', cookie: login.cookie });
      assert.equal((await request(base, '/api/admin/promos', { cookie: login.cookie })).status, 401);
    });

    it('lets staff create promos, inspect claims, see remaining uses and mark claims delivered', async (t) => {
      const { base, store } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });
      store.savePromo({ date: '2026-03-10', code: 'TODAY', reward: '1x Diamond Kit', maxClaims: 3 });
      await claim(base, { code: 'TODAY', username: 'Steve_01', confirmUsername: 'Steve_01' });

      const { cookie } = await adminLogin(base);

      const created = await request(base, '/api/admin/promos', {
        method: 'POST',
        cookie,
        body: { date: '2026-03-13', code: 'future-friday', reward: '2x Netherite Ingot', maxClaims: 25 },
      });
      assert.equal(created.status, 201);
      assert.equal(created.json.promo.code, 'FUTURE-FRIDAY');
      assert.equal(created.json.promo.status, 'upcoming');
      assert.equal(created.json.promo.remaining, 25);

      const duplicate = await request(base, '/api/admin/promos', {
        method: 'POST',
        cookie,
        body: { date: '2026-03-13', code: 'OTHER', reward: 'Another reward', maxClaims: 5 },
      });
      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.json.error.code, 'DATE_TAKEN');

      const invalidMax = await request(base, '/api/admin/promos', {
        method: 'POST',
        cookie,
        body: { date: '2026-03-14', code: 'SATURDAY', reward: 'Weekend kit', maxClaims: 0 },
      });
      assert.equal(invalidMax.status, 400);
      assert.equal(invalidMax.json.error.code, 'INVALID_PROMO');

      const promos = await request(base, '/api/admin/promos', { cookie });
      const todayRow = promos.json.promos.find((promo) => promo.date === '2026-03-10');
      assert.equal(todayRow.claims, 1);
      assert.equal(todayRow.remaining, 2);
      assert.equal(todayRow.status, 'today');
      assert.equal(promos.json.promos.find((promo) => promo.date === '2026-03-13').status, 'upcoming');

      const claims = await request(base, '/api/admin/claims', { cookie });
      assert.equal(claims.status, 200);
      assert.equal(claims.json.total, 1);
      const firstClaim = claims.json.claims[0];
      assert.equal(firstClaim.username, 'Steve_01');
      assert.equal(firstClaim.promo_date_label, 'Mar 10, 2026');
      assert.equal(firstClaim.claimed_at_local, 'Tuesday, March 10, 2026 at 11:00 AM EDT');
      assert.equal(firstClaim.delivered, false);

      const delivered = await request(base, `/api/admin/claims/${firstClaim.id}/delivered`, {
        method: 'POST',
        cookie,
        body: { delivered: true },
      });
      assert.equal(delivered.status, 200);
      assert.equal(delivered.json.claim.delivered, true);

      const overview = await request(base, '/api/admin/overview', { cookie });
      assert.equal(overview.json.overview.totals.claims, 1);
      assert.equal(overview.json.overview.totals.delivered, 1);
      assert.equal(overview.json.overview.totals.pending, 0);
      assert.equal(overview.json.overview.today.code, 'TODAY');
      assert.equal(overview.json.overview.upcoming.length, 7);

      const blockedDelete = await request(base, `/api/admin/promos/${todayRow.id}`, { method: 'DELETE', cookie });
      assert.equal(blockedDelete.status, 409);
      assert.equal(blockedDelete.json.error.code, 'HAS_CLAIMS');
    });

    it('never exposes the admin password or password hash to public visitors', async (t) => {
      const { base } = await startServer(t, { clock: () => new Date('2026-03-10T15:00:00Z') });

      for (const pathname of ['/', '/admin', '/admin.js', '/app.js', '/styles.css']) {
        const page = await request(base, pathname);
        assert.equal(page.status, 200, pathname);
        assert.ok(!page.text.includes(ADMIN_PASSWORD), `${pathname} must not contain the admin password`);
        assert.ok(!page.text.includes('scrypt$'), `${pathname} must not contain a password hash`);
        assert.ok(!page.text.includes('admin_password_hash'), `${pathname} must not reference the stored hash`);
      }

      const config = await request(base, '/api/public/config');
      assert.ok(!JSON.stringify(config.json).toLowerCase().includes('password'));

      const unknown = await request(base, '/api/nope');
      assert.equal(unknown.status, 404);
    });
  });
});

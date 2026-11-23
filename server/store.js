import fs from 'node:fs';
import path from 'node:path';

import { Database } from 'node-sqlite3-wasm';

import { hashPassword, hashToken, newSessionToken, randomPassword, verifyPassword } from './auth.js';
import {
  COOLDOWN_HOURS,
  COOLDOWN_MS,
  TIMEZONE,
  addDays,
  isValidDateString,
  nextTorontoMidnight,
  torontoDate,
  torontoDateLabel,
  torontoTimeLabel,
  torontoWeekday,
} from './time.js';

export const SUCCESS_MESSAGE = 'Your reward has been claimed! Delivery may take up to 3 days.';
const MAX_CLAIMS_LIMIT = 100000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

function failure(status, code, message, extra = {}) {
  return { ok: false, status, error: { code, message, ...extra } };
}

function normaliseCode(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function isConstraintError(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? ''}`.toUpperCase();
  return text.includes('CONSTRAINT');
}

function promoView(row, now = new Date()) {
  if (!row) return null;
  const today = torontoDate(now);
  const status = row.promo_date < today ? 'past' : row.promo_date > today ? 'upcoming' : 'today';
  const claims = row.claim_count ?? 0;
  return {
    id: row.id,
    date: row.promo_date,
    date_label: torontoDateLabel(row.promo_date),
    weekday: torontoWeekday(row.promo_date),
    code: row.code,
    reward: row.reward,
    max_claims: row.max_claims,
    remaining: Math.max(0, row.max_claims - claims),
    claims,
    active: row.active === 1,
    note: row.note || '',
    status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createStore({ dbPath, adminPassword = null, clock = () => new Date(), logger = console }) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }

  const db = new Database(dbPath);
  // Durability first: every committed write is flushed to the database file, so
  // claims survive refreshes, restarts and redeploys of the web server.
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = FULL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_date TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL,
      reward TEXT NOT NULL,
      max_claims INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      promo_id INTEGER NOT NULL REFERENCES promos(id),
      promo_date TEXT NOT NULL,
      code TEXT NOT NULL,
      reward TEXT NOT NULL,
      username TEXT NOT NULL,
      username_lower TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      claimed_date TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      delivered INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_username_day ON claims(username_lower, promo_date);
    CREATE INDEX IF NOT EXISTS idx_claims_username_time ON claims(username_lower, claimed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_claims_promo ON claims(promo_id);
    CREATE INDEX IF NOT EXISTS idx_claims_time ON claims(claimed_at DESC);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT ''
    );
  `);

  const now = () => clock();

  /** Run a function inside an immediate SQLite transaction. */
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Rollback failed:', rollbackError);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- settings
  const getSetting = (key) => db.get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;
  const setSetting = (key, value) =>
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, now().toISOString()],
    );

  // ------------------------------------------------------------ admin login
  const envPasswordHash = adminPassword ? hashPassword(adminPassword) : null;
  const passwordMode = envPasswordHash ? 'environment' : getSetting('admin_password_hash') ? 'database' : 'bootstrap';

  if (passwordMode === 'bootstrap') {
    const generated = randomPassword(18);
    setSetting('admin_password_hash', hashPassword(generated));
    logger.log(
      [
        '',
        '============================================================',
        ' FRAMES BASEMENT REWARDS - first run admin password',
        ` password: ${generated}`,
        ' Open /admin and sign in, then change it in the admin panel',
        ' or set the ADMIN_PASSWORD environment variable.',
        '============================================================',
        '',
      ].join('\n'),
    );
  }

  function verifyAdminPassword(password) {
    if (passwordMode === 'environment') return verifyPassword(password, envPasswordHash);
    return verifyPassword(password, getSetting('admin_password_hash'));
  }

  function changeAdminPassword(currentPassword, nextPassword) {
    if (passwordMode === 'environment') {
      return failure(
        409,
        'PASSWORD_MANAGED',
        'The admin password is managed by the ADMIN_PASSWORD environment variable. Change it in your hosting settings.',
      );
    }
    if (!verifyAdminPassword(currentPassword)) {
      return failure(401, 'BAD_CREDENTIALS', 'The current password is not correct.');
    }
    if (typeof nextPassword !== 'string' || nextPassword.length < 10) {
      return failure(400, 'WEAK_PASSWORD', 'Choose a password with at least 10 characters.');
    }
    setSetting('admin_password_hash', hashPassword(nextPassword));
    db.run('DELETE FROM admin_sessions');
    return { ok: true, password_mode: 'database' };
  }

  // --------------------------------------------------------------- sessions
  function createSession({ ip = '', userAgent = '' } = {}) {
    const token = newSessionToken();
    const created = now();
    const expires = new Date(created.getTime() + SESSION_TTL_MS);
    db.run('INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)', [
      hashToken(token),
      created.toISOString(),
      expires.toISOString(),
      ip,
      String(userAgent).slice(0, 250),
    ]);
    db.run('DELETE FROM admin_sessions WHERE expires_at < ?', [created.toISOString()]);
    return { token, expiresAt: expires };
  }

  function sessionIsValid(token) {
    if (!token) return false;
    const row = db.get('SELECT expires_at FROM admin_sessions WHERE token_hash = ?', [hashToken(token)]);
    if (!row) return false;
    if (new Date(row.expires_at).getTime() <= now().getTime()) {
      db.run('DELETE FROM admin_sessions WHERE token_hash = ?', [hashToken(token)]);
      return false;
    }
    return true;
  }

  function destroySession(token) {
    if (token) db.run('DELETE FROM admin_sessions WHERE token_hash = ?', [hashToken(token)]);
  }

  // ----------------------------------------------------------------- promos
  const promoSelect = `
    SELECT p.*, (SELECT COUNT(*) FROM claims c WHERE c.promo_id = p.id) AS claim_count
    FROM promos p
  `;

  const getPromoByDate = (date) => db.get(`${promoSelect} WHERE p.promo_date = ?`, [date]) ?? null;
  const getPromoById = (id) => db.get(`${promoSelect} WHERE p.id = ?`, [Number(id)]) ?? null;

  function listPromos() {
    const rows = db.all(`${promoSelect} ORDER BY p.promo_date ASC`);
    const current = now();
    return rows.map((row) => promoView(row, current));
  }

  function validatePromoInput({ date, code, reward, maxClaims }) {
    if (!isValidDateString(date)) return 'Choose a valid promo date (YYYY-MM-DD).';
    if (!code) return 'Enter a promo code.';
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) {
      return 'Promo codes must be 3-32 characters: letters, numbers, hyphen or underscore.';
    }
    if (!reward) return 'Describe the reward for this day.';
    if (reward.length > 160) return 'Keep the reward description under 160 characters.';
    if (!Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > MAX_CLAIMS_LIMIT) {
      return `Maximum claims must be a whole number between 1 and ${MAX_CLAIMS_LIMIT}.`;
    }
    return null;
  }

  function savePromo({ id = null, date, code, reward, maxClaims, active = true, note = '' }) {
    const cleanCode = normaliseCode(code);
    const cleanReward = String(reward ?? '').trim();
    const numericMax = Number(maxClaims);
    const error = validatePromoInput({ date, code: cleanCode, reward: cleanReward, maxClaims: numericMax });
    if (error) return failure(400, 'INVALID_PROMO', error);

    const existingByDate = db.get('SELECT id FROM promos WHERE promo_date = ?', [date]);
    if (existingByDate && (!id || existingByDate.id !== Number(id))) {
      return failure(409, 'DATE_TAKEN', `A promo already exists for ${date}. Edit that day instead.`);
    }

    const stamp = now().toISOString();
    const isActive = active ? 1 : 0;

    if (id) {
      const current = db.get('SELECT * FROM promos WHERE id = ?', [Number(id)]);
      if (!current) return failure(404, 'NOT_FOUND', 'That promo no longer exists.');
      const usedClaims = db.get('SELECT COUNT(*) AS c FROM claims WHERE promo_id = ?', [current.id]).c;
      if (numericMax < usedClaims) {
        return failure(
          400,
          'LIMIT_BELOW_CLAIMS',
          `This day already has ${usedClaims} claims, so the maximum cannot be lower than ${usedClaims}.`,
        );
      }
      db.run(
        `UPDATE promos SET promo_date = ?, code = ?, reward = ?, max_claims = ?, active = ?, note = ?, updated_at = ?
         WHERE id = ?`,
        [date, cleanCode, cleanReward, numericMax, isActive, String(note).slice(0, 200), stamp, current.id],
      );
      return { ok: true, promo: promoView(getPromoById(current.id), now()) };
    }

    const inserted = db.run(
      `INSERT INTO promos (promo_date, code, reward, max_claims, active, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [date, cleanCode, cleanReward, numericMax, isActive, String(note).slice(0, 200), stamp, stamp],
    );
    return { ok: true, promo: promoView(getPromoById(inserted.lastInsertRowid), now()) };
  }

  function deletePromo(id) {
    const promo = db.get('SELECT * FROM promos WHERE id = ?', [Number(id)]);
    if (!promo) return failure(404, 'NOT_FOUND', 'That promo no longer exists.');
    const usedClaims = db.get('SELECT COUNT(*) AS c FROM claims WHERE promo_id = ?', [promo.id]).c;
    if (usedClaims > 0) {
      return failure(
        409,
        'HAS_CLAIMS',
        `This promo has ${usedClaims} claim(s) on record and is kept for claim history. Turn it off instead of deleting it.`,
      );
    }
    db.run('DELETE FROM promos WHERE id = ?', [promo.id]);
    return { ok: true };
  }

  // ----------------------------------------------------------------- claims
  function lastClaimForUser(usernameLower) {
    return db.get('SELECT * FROM claims WHERE username_lower = ? ORDER BY claimed_at DESC LIMIT 1', [usernameLower]);
  }

  function cooldownInfo(row, current) {
    if (!row) return null;
    const lastAt = new Date(row.claimed_at).getTime();
    const availableAt = lastAt + COOLDOWN_MS;
    if (current.getTime() >= availableAt) return null;
    const until = new Date(availableAt);
    return {
      last_claim_at: row.claimed_at,
      last_claim_at_local: torontoTimeLabel(row.claimed_at),
      unavailable_until: until.toISOString(),
      unavailable_until_local: torontoTimeLabel(until),
      seconds_remaining: Math.max(1, Math.ceil((availableAt - current.getTime()) / 1000)),
      cooldown_hours: COOLDOWN_HOURS,
    };
  }

  function claimReward({ code, username, confirmUsername, ip = '' }) {
    const rawUser = String(username ?? '').trim();
    const confirm = String(confirmUsername ?? '').trim();
    const cleanCode = normaliseCode(code);

    if (!rawUser) return failure(400, 'USERNAME_REQUIRED', 'Enter your Minecraft username.');
    if (!USERNAME_PATTERN.test(rawUser)) {
      return failure(
        400,
        'INVALID_USERNAME',
        'Minecraft usernames are 3-16 characters using letters, numbers or underscores.',
      );
    }
    if (!confirm) return failure(400, 'CONFIRM_REQUIRED', 'Re-enter your Minecraft username to confirm it.');
    if (rawUser.toLowerCase() !== confirm.toLowerCase()) {
      return failure(400, 'USERNAME_MISMATCH', 'The two Minecraft usernames do not match. Please check and try again.');
    }
    if (!cleanCode) return failure(400, 'CODE_REQUIRED', 'Enter the promo code from today’s announcement.');

    const usernameLower = rawUser.toLowerCase();

    // Everything below runs inside one transaction, so two people clicking at the
    // same moment cannot both take the last claim or bypass the cooldown.
    return transaction(() => {
      const current = now();
      const today = torontoDate(current);
      const promo = getPromoByDate(today);

      if (!promo || promo.active !== 1) {
        return failure(
          404,
          'NO_ACTIVE_PROMO',
          `There is no promo code running right now for ${today} (${TIMEZONE}). Check the announcements for today’s code.`,
        );
      }
      if (promo.code !== cleanCode) {
        return failure(
          400,
          'INVALID_CODE',
          'That code is not today’s promo code. Only the current day’s code can be claimed.',
        );
      }

      const used = db.get('SELECT COUNT(*) AS c FROM claims WHERE promo_id = ?', [promo.id]).c;
      if (used >= promo.max_claims) {
        return failure(
          409,
          'PROMO_EXHAUSTED',
          `Today’s promo code has reached its limit of ${promo.max_claims} claims. A new code drops at midnight (${TIMEZONE}).`,
        );
      }

      const existingCooldown = cooldownInfo(lastClaimForUser(usernameLower), current);
      if (existingCooldown) {
        return failure(
          429,
          'COOLDOWN',
          `This Minecraft username already claimed a reward. It can claim again on ${existingCooldown.unavailable_until_local}.`,
          existingCooldown,
        );
      }

      try {
        const inserted = db.run(
          `INSERT INTO claims (promo_id, promo_date, code, reward, username, username_lower, claimed_at, claimed_date, ip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            promo.id,
            promo.promo_date,
            promo.code,
            promo.reward,
            rawUser,
            usernameLower,
            current.toISOString(),
            today,
            String(ip || '').slice(0, 60),
          ],
        );

        const claim = db.get('SELECT * FROM claims WHERE id = ?', [inserted.lastInsertRowid]);
        return {
          ok: true,
          status: 201,
          message: SUCCESS_MESSAGE,
          claim: {
            id: claim.id,
            username: claim.username,
            reward: claim.reward,
            promo_date: claim.promo_date,
            claimed_at: claim.claimed_at,
            claimed_at_local: torontoTimeLabel(claim.claimed_at),
            delivered: false,
          },
          next_claim_at: new Date(current.getTime() + COOLDOWN_MS).toISOString(),
          next_claim_at_local: torontoTimeLabel(new Date(current.getTime() + COOLDOWN_MS)),
        };
      } catch (error) {
        if (isConstraintError(error)) {
          return failure(409, 'ALREADY_CLAIMED', 'This Minecraft username has already claimed today’s promo code.');
        }
        throw error;
      }
    });
  }

  function publicStatus(username) {
    const raw = String(username ?? '').trim();
    if (!USERNAME_PATTERN.test(raw)) return null;
    const current = now();
    return cooldownInfo(lastClaimForUser(raw.toLowerCase()), current);
  }

  function listClaims({ limit = 50, offset = 0, delivered = null, search = '' } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    const filters = [];
    const params = [];
    if (delivered === 'pending' || delivered === 'delivered') {
      filters.push('c.delivered = ?');
      params.push(delivered === 'delivered' ? 1 : 0);
    }
    if (search) {
      filters.push('c.username_lower LIKE ?');
      params.push(`%${String(search).trim().toLowerCase()}%`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const total = db.get(`SELECT COUNT(*) AS c FROM claims c ${where}`, params).c;
    const rows = db.all(
      `SELECT c.*, p.reward AS promo_reward FROM claims c
       LEFT JOIN promos p ON p.id = c.promo_id
       ${where}
       ORDER BY c.claimed_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, safeLimit, safeOffset],
    );

    return {
      total,
      limit: safeLimit,
      offset: safeOffset,
      claims: rows.map((row) => ({
        id: row.id,
        username: row.username,
        reward: row.reward,
        code: row.code,
        promo_date: row.promo_date,
        promo_date_label: torontoDateLabel(row.promo_date),
        claimed_at: row.claimed_at,
        claimed_at_local: torontoTimeLabel(row.claimed_at),
        delivered: row.delivered === 1,
        delivered_at: row.delivered_at,
      })),
    };
  }

  function setDelivered(id, delivered) {
    const claim = db.get('SELECT * FROM claims WHERE id = ?', [Number(id)]);
    if (!claim) return failure(404, 'NOT_FOUND', 'That claim no longer exists.');
    const stamp = now().toISOString();
    db.run('UPDATE claims SET delivered = ?, delivered_at = ? WHERE id = ?', [
      delivered ? 1 : 0,
      delivered ? stamp : null,
      claim.id,
    ]);
    const updated = db.get('SELECT * FROM claims WHERE id = ?', [claim.id]);
    return {
      ok: true,
      claim: {
        id: updated.id,
        username: updated.username,
        delivered: updated.delivered === 1,
        delivered_at: updated.delivered_at,
      },
    };
  }

  function deleteClaim(id) {
    const claim = db.get('SELECT * FROM claims WHERE id = ?', [Number(id)]);
    if (!claim) return failure(404, 'NOT_FOUND', 'That claim no longer exists.');
    db.run('DELETE FROM claims WHERE id = ?', [claim.id]);
    return { ok: true };
  }

  // -------------------------------------------------------------- public view
  function todayPromo(current = now()) {
    const today = torontoDate(current);
    const promo = getPromoByDate(today);
    const view = promoView(promo, current);
    const nextMidnight = nextTorontoMidnight(current);
    return {
      date: today,
      date_label: torontoDateLabel(today),
      weekday: torontoWeekday(today),
      timezone: TIMEZONE,
      server_time: current.toISOString(),
      next_switch_at: nextMidnight.toISOString(),
      next_switch_at_local: torontoTimeLabel(nextMidnight),
      has_promo: Boolean(promo && promo.active === 1),
      reward: view?.reward ?? null,
      remaining: view?.remaining ?? 0,
      max_claims: view?.max_claims ?? 0,
      claims: view?.claims ?? 0,
      cooldown_hours: COOLDOWN_HOURS,
      success_message: SUCCESS_MESSAGE,
    };
  }

  function overview() {
    const current = now();
    const today = todayPromo(current);
    const todayRow = getPromoByDate(today.date);
    const totals = db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN delivered = 1 THEN 1 ELSE 0 END) AS delivered,
              COUNT(DISTINCT username_lower) AS usernames
       FROM claims`,
    );
    const upcoming = [];
    for (let i = 1; i <= 7; i += 1) {
      const date = addDays(today.date, i);
      const promo = getPromoByDate(date);
      upcoming.push({
        date,
        date_label: torontoDateLabel(date),
        weekday: torontoWeekday(date),
        has_promo: Boolean(promo),
        code: promo?.code ?? null,
        reward: promo?.reward ?? null,
        max_claims: promo?.max_claims ?? 0,
        claims: promo?.claim_count ?? 0,
        remaining: promo ? Math.max(0, promo.max_claims - promo.claim_count) : 0,
      });
    }
    const promos = listPromos();
    return {
      timezone: TIMEZONE,
      server_time: current.toISOString(),
      password_mode: passwordMode,
      today: { ...today, code: todayRow?.code ?? null, promo_id: todayRow?.id ?? null },
      totals: {
        claims: totals.total ?? 0,
        delivered: totals.delivered ?? 0,
        pending: (totals.total ?? 0) - (totals.delivered ?? 0),
        usernames: totals.usernames ?? 0,
      },
      upcoming,
      promos: {
        past: promos.filter((p) => p.status === 'past').reverse(),
        today: promos.filter((p) => p.status === 'today'),
        upcoming: promos.filter((p) => p.status === 'upcoming'),
      },
    };
  }

  return {
    db,
    passwordMode,
    now,
    verifyAdminPassword,
    changeAdminPassword,
    createSession,
    sessionIsValid,
    destroySession,
    getPromoByDate,
    getPromoById,
    listPromos,
    savePromo,
    deletePromo,
    claimReward,
    publicStatus,
    listClaims,
    setDelivered,
    deleteClaim,
    todayPromo,
    overview,
    close: () => db.close(),
  };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { createRateLimiter } from './ratelimit.js';
import { SUCCESS_MESSAGE, createStore } from './store.js';
import { TIMEZONE, isValidDateString, torontoDate } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'fb_admin_session';
const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function isSecureRequest(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function buildSessionCookie(token, req, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

export function createApp({ dbPath, adminPassword = process.env.ADMIN_PASSWORD || null, clock, logger = console } = {}) {
  const store = createStore({ dbPath, adminPassword, clock, logger });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.locals.store = store;

  app.use((req, res, next) => {
    req.clientIp =
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    );
    next();
  });

  app.use(express.json({ limit: '32kb' }));

  // Keyed by connection + Minecraft username so members sharing a network (or a hosting proxy)
  // cannot lock each other out, while a single username still cannot be scripted.
  const claimLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'Too many claim attempts for this username. Please wait a few minutes and try again.',
    keyGenerator: (req) => {
      const username = String(req.body?.username ?? '').trim().toLowerCase();
      return `${req.clientIp || 'unknown'}|${username}`;
    },
  });
  const loginLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: 'Too many admin sign-in attempts. Please wait a few minutes and try again.',
  });

  function requireAdmin(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    if (!store.sessionIsValid(cookies[SESSION_COOKIE])) {
      return res.status(401).json({
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Sign in to the admin panel first.' },
      });
    }
    req.adminToken = cookies[SESSION_COOKIE];
    return next();
  }

  // ------------------------------------------------------------------ public
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'frames-basement-rewards', timezone: TIMEZONE, time: store.now().toISOString() });
  });

  app.get('/api/public/config', (req, res) => {
    res.json({
      ok: true,
      title: 'FRAMES BASEMENT REWARDS',
      timezone: TIMEZONE,
      success_message: SUCCESS_MESSAGE,
      today: store.todayPromo(),
    });
  });

  app.get('/api/public/status', (req, res) => {
    const cooldown = store.publicStatus(req.query.username);
    res.json({ ok: true, cooldown });
  });

  app.post('/api/public/claim', claimLimiter, (req, res) => {
    const body = req.body ?? {};
    const result = store.claimReward({
      code: body.code,
      username: body.username,
      confirmUsername: body.confirmUsername ?? body.confirm_username,
      ip: req.clientIp,
    });

    if (!result.ok) {
      return res.status(result.status).json({ ok: false, error: result.error });
    }
    return res.status(201).json({
      ok: true,
      message: result.message,
      claim: result.claim,
      next_claim_at: result.next_claim_at,
      next_claim_at_local: result.next_claim_at_local,
      today: store.todayPromo(),
    });
  });

  // ------------------------------------------------------------------- admin
  app.post('/api/admin/login', loginLimiter, (req, res) => {
    const password = String(req.body?.password ?? '');
    if (!password) {
      return res
        .status(400)
        .json({ ok: false, error: { code: 'PASSWORD_REQUIRED', message: 'Enter the admin password.' } });
    }
    if (!store.verifyAdminPassword(password)) {
      return res
        .status(401)
        .json({ ok: false, error: { code: 'BAD_CREDENTIALS', message: 'That admin password is not correct.' } });
    }
    const session = store.createSession({ ip: req.clientIp, userAgent: req.headers['user-agent'] || '' });
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, req));
    return res.json({ ok: true, expires_at: session.expiresAt.toISOString(), password_mode: store.passwordMode });
  });

  app.post('/api/admin/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    store.destroySession(cookies[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    res.json({ ok: true });
  });

  app.get('/api/admin/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const authenticated = store.sessionIsValid(cookies[SESSION_COOKIE]);
    res.json({ ok: true, authenticated, password_mode: store.passwordMode });
  });

  app.post('/api/admin/password', requireAdmin, (req, res) => {
    const result = store.changeAdminPassword(req.body?.currentPassword, req.body?.newPassword);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    // Every existing session (including this one) is revoked after a password change.
    res.setHeader('Set-Cookie', clearSessionCookie(req));
    return res.json({ ok: true, message: 'Admin password updated. Please sign in again.' });
  });

  app.get('/api/admin/overview', requireAdmin, (req, res) => {
    res.json({ ok: true, overview: store.overview() });
  });

  app.get('/api/admin/promos', requireAdmin, (req, res) => {
    res.json({ ok: true, today: torontoDate(store.now()), timezone: TIMEZONE, promos: store.listPromos() });
  });

  app.post('/api/admin/promos', requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const result = store.savePromo({
      date: String(body.date ?? ''),
      code: body.code,
      reward: body.reward,
      maxClaims: body.maxClaims ?? body.max_claims,
      active: body.active !== false,
      note: body.note ?? '',
    });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.status(201).json({ ok: true, promo: result.promo });
  });

  app.put('/api/admin/promos/:id', requireAdmin, (req, res) => {
    const body = req.body ?? {};
    const result = store.savePromo({
      id: req.params.id,
      date: String(body.date ?? ''),
      code: body.code,
      reward: body.reward,
      maxClaims: body.maxClaims ?? body.max_claims,
      active: body.active !== false,
      note: body.note ?? '',
    });
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true, promo: result.promo });
  });

  app.delete('/api/admin/promos/:id', requireAdmin, (req, res) => {
    const result = store.deletePromo(req.params.id);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true });
  });

  app.get('/api/admin/claims', requireAdmin, (req, res) => {
    const result = store.listClaims({
      limit: req.query.limit,
      offset: req.query.offset,
      delivered: req.query.delivered ?? null,
      search: req.query.search ?? '',
    });
    res.json({ ok: true, ...result });
  });

  app.post('/api/admin/claims/:id/delivered', requireAdmin, (req, res) => {
    const delivered = req.body?.delivered !== false;
    const result = store.setDelivered(req.params.id, delivered);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true, claim: result.claim });
  });

  app.delete('/api/admin/claims/:id', requireAdmin, (req, res) => {
    const result = store.deleteClaim(req.params.id);
    if (!result.ok) return res.status(result.status).json({ ok: false, error: result.error });
    return res.json({ ok: true });
  });

  app.get('/api/admin/promo-date-suggestion', requireAdmin, (req, res) => {
    const base = isValidDateString(req.query.after) ? req.query.after : torontoDate(store.now());
    res.json({ ok: true, today: torontoDate(store.now()), after: base });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
  });

  // ------------------------------------------------------------------ static
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: '5m', index: 'index.html' }));
  app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
  app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html')));

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body.' } });
    }
    logger.error('Unhandled request error:', err);
    if (res.headersSent) return next(err);
    return res
      .status(500)
      .json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Something went wrong. Please try again.' } });
  });

  return app;
}

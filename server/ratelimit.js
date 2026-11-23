/**
 * Small in-memory sliding-window limiter.
 * It protects the public claim endpoint and the admin login from scripted abuse.
 * Limits are enforced in addition to (never instead of) the database rules.
 */
export function createRateLimiter({ windowMs, max, message, keyGenerator }) {
  const hits = new Map();

  const middleware = (req, res, next) => {
    const now = Date.now();
    const generated = typeof keyGenerator === 'function' ? keyGenerator(req) : null;
    const key = generated || req.clientIp || req.ip || 'unknown';
    const entry = hits.get(key);
    const recent = entry ? entry.filter((stamp) => now - stamp < windowMs) : [];

    if (recent.length >= max) {
      const retryAfterMs = windowMs - (now - recent[0]);
      const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: message || 'Too many attempts. Please wait a moment and try again.',
          retry_after_seconds: retryAfter,
        },
      });
    }

    recent.push(now);
    hits.set(key, recent);

    if (hits.size > 5000) {
      for (const [ip, stamps] of hits) {
        if (!stamps.some((stamp) => now - stamp < windowMs)) hits.delete(ip);
      }
    }

    return next();
  };

  middleware.reset = () => hits.clear();
  return middleware;
}

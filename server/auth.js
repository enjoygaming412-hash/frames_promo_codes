import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_KEYLEN = 64;

/** Hash an admin password for storage. Format: scrypt$<salt>$<hash>. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/** Constant-time verification of a password against a stored hash. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string' || password.length === 0) return false;
  const [scheme, salt, digest] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  let expected;
  try {
    expected = Buffer.from(digest, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(candidate, expected);
}

/** Session tokens are random and only their SHA-256 digest is stored server side. */
export function newSessionToken() {
  return randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function randomPassword(length = 18) {
  // Unambiguous alphabet so the bootstrap password is easy to copy from logs.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// scrypt cost parameters (N, r, p) and output length. Stored with each hash, so they can be
// raised later without breaking existing passwords.
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
// N = 2^15 with r = 8 needs 32 MiB; Node's default limit is exactly that, so allow a little more.
const MAX_MEMORY = 64 * 1024 * 1024;

/**
 * Hashes a password with scrypt and a random salt, as "scrypt$N$r$p$salt$hash" (base64url).
 *
 * @param {string} password
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEMORY });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Whether `password` matches `stored` (from hashPassword), compared in constant time.
 *
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAX_MEMORY,
  });
  return timingSafeEqual(key, expected);
}

/**
 * A hash that matches no password, checked against when an email has no account, so a login
 * for an unknown email takes as long as one with a wrong password.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('hex'));

import express from 'express';
import mongoose from 'mongoose';
import { HttpError } from '../works/errors.js';
import { SESSION_TTL_MS } from './authService.js';
import { createRateLimiter } from './rateLimit.js';

export const SESSION_COOKIE = 'tracer_session';

/** The value of cookie `name` from a request's Cookie header, if any. */
export function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Attaches the signed-in account (or null) as `req.user`, for routes that need one (e.g.
 * saved graphs, later).
 */
export function loadUser(authService) {
  return async (req, res, next) => {
    req.user = await authService.userForToken(readCookie(req, SESSION_COOKIE));
    next();
  };
}

/**
 * Routes under /api/auth: sign up, log in, log out, and who's signed in.
 *
 * Sessions are a random token in an httpOnly, SameSite=Lax cookie (Secure in production).
 * State-changing requests must be JSON and, when the browser sends an Origin, same-origin:
 * together with SameSite that stops other sites from submitting them.
 *
 * @param {ReturnType<typeof import('./authService.js').createAuthService>} authService
 * @param {object} [options]
 * @param {boolean} [options.secureCookies]  Mark the cookie Secure (HTTPS only).
 * @param {() => number} [options.now]  Clock for rate limits; injected for tests.
 */
export function createAuthRouter(authService, { secureCookies = false, now } = {}) {
  const router = express.Router();
  // Guessing passwords: per address, and per account across addresses.
  const loginsByIp = createRateLimiter({ max: 30, windowMs: 15 * 60 * 1000, now });
  const loginsByEmail = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000, now });
  const signUpsByIp = createRateLimiter({ max: 10, windowMs: 60 * 60 * 1000, now });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    path: '/',
  };
  const setSession = (res, token) =>
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });

  router.use((req, res, next) => {
    if (mongoose.connection.readyState !== 1) throw new HttpError(503, 'Database unavailable');
    if (req.method === 'POST') {
      if (!req.is('application/json')) throw new HttpError(415, 'Send JSON');
      const origin = req.get('origin');
      if (origin && new URL(origin).host !== req.get('host')) {
        throw new HttpError(403, 'Cross-site request refused');
      }
    }
    next();
  });

  router.post('/signup', async (req, res) => {
    if (!signUpsByIp.attempt(req.ip)) {
      throw new HttpError(429, 'Too many sign-ups from this address; try again later');
    }
    const { user, token } = await authService.signUp(req.body?.email, req.body?.password);
    setSession(res, token);
    res.status(201).json({ user });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!loginsByIp.attempt(req.ip) || !loginsByEmail.attempt(email)) {
      throw new HttpError(429, 'Too many login attempts; try again in a few minutes');
    }
    const { user, token } = await authService.logIn(req.body?.email, req.body?.password);
    setSession(res, token);
    res.json({ user });
  });

  router.post('/logout', async (req, res) => {
    await authService.endSession(readCookie(req, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    res.json({ user: await authService.userForToken(readCookie(req, SESSION_COOKIE)) });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    // Malformed JSON bodies.
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}

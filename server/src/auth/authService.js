import { createHash, randomBytes } from 'node:crypto';
import { Identity } from '../models/Identity.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { HttpError } from '../works/errors.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = 30 * DAY_MS;

// Long enough to resist guessing; capped so a huge "password" can't tie up scrypt.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @typedef {{ id: string, email: string, plan: string, planOverrides?: object }} Account
 *   A signed-in account, as routes see it (req.user). `planOverrides` is for entitlements and
 *   isn't sent to the client (see clientUser).
 */

/** @returns {Account} */
const account = (user) => ({
  id: String(user._id),
  email: user.email,
  plan: user.plan ?? 'free',
  ...(user.planOverrides ? { planOverrides: user.planOverrides } : {}),
});

/** What the client sees of an account. */
export const clientUser = ({ id, email, plan }) => ({ id, email, plan });
const tokenHash = (token) => createHash('sha256').update(token).digest('base64url');

/** Lowercased, trimmed email, or a 400 if it isn't one. */
export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new HttpError(400, 'Enter a valid email address');
  }
  return email;
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `Use a password of at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

/**
 * Accounts, email-and-password sign-in, and sessions.
 *
 * Accounts (User) and sign-in methods (Identity) are separate, so adding ORCID or Google means
 * a new Identity provider and its OAuth routes, which end by calling startSession like
 * logIn does. Password reset (not built yet) would add a short-lived, single-use token stored
 * hashed like sessions, a route to email it, and one to set a new passwordHash and end the
 * account's other sessions (endAllSessions).
 *
 * @param {object} [options]
 * @param {() => Date} [options.now]  Injected for tests.
 */
export function createAuthService({ now = () => new Date() } = {}) {
  /** Starts a session for an account; returns the token for the cookie. */
  async function startSession(userId) {
    const token = randomBytes(32).toString('base64url');
    const createdAt = now();
    await Session.create({
      _id: tokenHash(token),
      userId,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + SESSION_TTL_MS),
    });
    return token;
  }

  return {
    startSession,

    /**
     * Creates an account with a password and starts a session for it.
     *
     * @returns {Promise<{ user: PublicUser, token: string }>}
     */
    async signUp(emailInput, password) {
      const email = normalizeEmail(emailInput);
      checkPassword(password);
      if (await User.exists({ email })) {
        throw new HttpError(409, 'An account with that email already exists');
      }
      const passwordHash = await hashPassword(password);
      const createdAt = now();
      let user;
      try {
        user = await User.create({ email, createdAt });
      } catch (err) {
        // Two sign-ups racing for one email.
        if (err.code === 11000)
          throw new HttpError(409, 'An account with that email already exists');
        throw err;
      }
      await Identity.create({
        userId: user._id,
        provider: 'password',
        subject: email,
        passwordHash,
        createdAt,
      });
      return { user: account(user), token: await startSession(user._id) };
    },

    /**
     * Checks an email and password and starts a session. An unknown email and a wrong password
     * get the same error, after the same amount of work, so logins don't reveal who has an
     * account.
     *
     * @returns {Promise<{ user: PublicUser, token: string }>}
     */
    async logIn(emailInput, password) {
      const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
      const identity =
        typeof password === 'string' && password.length <= MAX_PASSWORD_LENGTH
          ? await Identity.findOne({ provider: 'password', subject: email }).lean().exec()
          : null;
      const matches = await verifyPassword(
        typeof password === 'string' ? password.slice(0, MAX_PASSWORD_LENGTH) : '',
        identity?.passwordHash ?? DUMMY_HASH,
      );
      const user = identity && matches && (await User.findById(identity.userId).lean().exec());
      if (!user) throw new HttpError(401, 'Incorrect email or password');
      return { user: account(user), token: await startSession(user._id) };
    },

    /** The account a session token belongs to, or null if it's unknown or expired. */
    async userForToken(token) {
      if (!token) return null;
      const session = await Session.findOne({ _id: tokenHash(token), expiresAt: { $gt: now() } })
        .lean()
        .exec();
      if (!session) return null;
      const user = await User.findById(session.userId).lean().exec();
      return user ? account(user) : null;
    },

    /** Ends one session (logging out). */
    async endSession(token) {
      if (token) await Session.deleteOne({ _id: tokenHash(token) });
    },

    /** Ends every session of an account (for password reset, later). */
    async endAllSessions(userId) {
      await Session.deleteMany({ userId });
    },
  };
}

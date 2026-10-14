import { HttpError } from '../works/errors.js';
import { FEATURES, LIMITS, PLANS } from './plans.js';

// What a user may do and how much, from their plan (plans.js) and any per-account overrides.
// Every gated route and control asks here, so changing what a plan includes, or adding billing,
// touches only this module and the account's `plan`.

const features = new Set(FEATURES);
const limits = new Set(LIMITS);

function checkKey(set, kind, key) {
  if (!set.has(key)) throw new Error(`Unknown ${kind}: ${key}`);
}

/**
 * The plan's features and limits, with the account's overrides (e.g. for testers) applied.
 * Overrides of unknown keys, or of the wrong type, are ignored.
 *
 * @param {{ plan?: string, planOverrides?: { features?: object, limits?: object } } | null} user
 *   An account (req.user), or null for someone signed out.
 * @returns {{ plan: string, features: Record<string, boolean>, limits: Record<string, number> }}
 */
export function entitlementsFor(user) {
  const plan = user
    ? PLANS[user.plan] && user.plan !== 'anonymous'
      ? user.plan
      : 'free'
    : 'anonymous';
  const base = PLANS[plan];
  const result = { plan, features: { ...base.features }, limits: { ...base.limits } };
  const overrides = user?.planOverrides;
  for (const [key, value] of Object.entries(overrides?.features ?? {})) {
    if (features.has(key) && typeof value === 'boolean') result.features[key] = value;
  }
  for (const [key, value] of Object.entries(overrides?.limits ?? {})) {
    if (limits.has(key) && Number.isInteger(value) && value >= 0) result.limits[key] = value;
  }
  return result;
}

/** Whether `user` (or null, signed out) has `feature`. Throws on an unknown feature. */
export function can(user, feature) {
  checkKey(features, 'feature', feature);
  return entitlementsFor(user).features[feature];
}

/** `user`'s limit named `limit`. Throws on an unknown limit. */
export function limitFor(user, limit) {
  checkKey(limits, 'limit', limit);
  return entitlementsFor(user).limits[limit];
}

/** A 403 for a feature or limit the user's plan doesn't include, naming which. */
export class EntitlementError extends HttpError {
  /**
   * @param {string} message
   * @param {{ feature?: string, limit?: string }} details
   */
  constructor(message, details) {
    super(403, message, details);
    this.name = 'EntitlementError';
  }
}

/** Throws a 403 unless `value` is within `user`'s `limit`. */
export function checkLimit(user, limit, value, message) {
  const max = limitFor(user, limit);
  if (value > max) {
    throw new EntitlementError(message ?? `Your plan allows at most ${max} (${limit})`, { limit });
  }
}

/** Middleware answering 403 unless the user (req.user, from loadUser) has `feature`. */
export function requireFeature(feature) {
  checkKey(features, 'feature', feature);
  return (req, res, next) => {
    if (!can(req.user ?? null, feature)) {
      throw new EntitlementError(
        req.user ? 'Your plan doesn’t include this' : 'Log in to use this',
        { feature },
      );
    }
    next();
  };
}

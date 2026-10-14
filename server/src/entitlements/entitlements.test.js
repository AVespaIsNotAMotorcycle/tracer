import { describe, expect, it } from 'vitest';
import {
  can,
  checkLimit,
  EntitlementError,
  entitlementsFor,
  limitFor,
  requireFeature,
} from './entitlements.js';
import { FEATURES, LIMITS, PLANS } from './plans.js';

const user = (fields = {}) => ({ id: 'u1', email: 'a@example.org', plan: 'free', ...fields });

describe('entitlementsFor', () => {
  it('gives signed-out visitors the anonymous plan, and accounts their own', () => {
    expect(entitlementsFor(null)).toEqual({ plan: 'anonymous', ...PLANS.anonymous });
    expect(entitlementsFor(user())).toEqual({ plan: 'free', ...PLANS.free });
    expect(entitlementsFor(user({ plan: 'scholar' })).plan).toBe('scholar');
  });

  it('treats an unknown plan on an account as free, never as anonymous', () => {
    expect(entitlementsFor(user({ plan: 'platinum' })).plan).toBe('free');
    expect(entitlementsFor(user({ plan: 'anonymous' })).plan).toBe('free');
    expect(entitlementsFor(user({ plan: undefined })).plan).toBe('free');
  });

  it('applies valid overrides and ignores unknown keys or wrong types', () => {
    const result = entitlementsFor(
      user({
        planOverrides: {
          features: { pathSearch: false, flying: true, coCitations: 'no' },
          limits: { maxNodes: 50, perNode: -1, depth: 1.5, wings: 2 },
        },
      }),
    );
    expect(result.features).toEqual({ ...PLANS.free.features, pathSearch: false });
    expect(result.limits).toEqual({ ...PLANS.free.limits, maxNodes: 50 });
  });

  it('defines every feature and limit for every plan', () => {
    for (const plan of Object.values(PLANS)) {
      expect(Object.keys(plan.features).sort()).toEqual([...FEATURES].sort());
      expect(Object.keys(plan.limits).sort()).toEqual([...LIMITS].sort());
    }
  });

  it('includes everything that exists for signed-in users, and all but saving signed out', () => {
    expect(Object.values(PLANS.free.features).every(Boolean)).toBe(true);
    expect(PLANS.anonymous.features).toMatchObject({ saveGraphs: false, autoSave: false });
    expect(PLANS.anonymous.features.pathSearch).toBe(true);
  });
});

describe('can, limitFor and checkLimit', () => {
  it('answer from the resolved plan', () => {
    expect(can(user(), 'saveGraphs')).toBe(true);
    expect(can(null, 'saveGraphs')).toBe(false);
    expect(limitFor(user({ planOverrides: { limits: { savedGraphs: 3 } } }), 'savedGraphs')).toBe(
      3,
    );
  });

  it('throw on unknown keys, so a typo can’t grant access', () => {
    expect(() => can(user(), 'pathsearch')).toThrow('Unknown feature: pathsearch');
    expect(() => limitFor(user(), 'nodes')).toThrow('Unknown limit: nodes');
    expect(() => requireFeature('nope')).toThrow('Unknown feature: nope');
  });

  it('checkLimit throws a 403 naming the limit only past it', () => {
    const limited = user({ planOverrides: { limits: { perNode: 10 } } });
    expect(() => checkLimit(limited, 'perNode', 10)).not.toThrow();
    let error;
    try {
      checkLimit(limited, 'perNode', 11);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EntitlementError);
    expect(error.status).toBe(403);
    expect(error.body()).toEqual({ error: expect.any(String), limit: 'perNode' });
  });
});

describe('requireFeature', () => {
  const run = (reqUser) => {
    let passed = false;
    let error = null;
    try {
      requireFeature('pathSearch')({ user: reqUser }, {}, () => {
        passed = true;
      });
    } catch (err) {
      error = err;
    }
    return { passed, error };
  };

  it('passes users who have the feature and refuses others with a 403 naming it', () => {
    expect(run(user()).passed).toBe(true);
    expect(run(null).passed).toBe(true);
    const { passed, error } = run(user({ planOverrides: { features: { pathSearch: false } } }));
    expect(passed).toBe(false);
    expect(error.status).toBe(403);
    expect(error.body()).toMatchObject({ feature: 'pathSearch' });
  });
});

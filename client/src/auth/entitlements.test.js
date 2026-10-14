import { describe, expect, it } from 'vitest';
import { PLANS } from '../../../server/src/entitlements/plans.js';
import { ANONYMOUS, can, clampOptions } from './entitlements.js';

describe('entitlements', () => {
  it('falls back to the same signed-out plan as the server', () => {
    expect(ANONYMOUS).toEqual({ plan: 'anonymous', ...PLANS.anonymous });
  });

  it('answers features and throws on unknown ones', () => {
    expect(can(ANONYMOUS, 'pathSearch')).toBe(true);
    expect(can(ANONYMOUS, 'saveGraphs')).toBe(false);
    expect(() => can(ANONYMOUS, 'pathsearch')).toThrow('Unknown feature');
  });

  it('clamps build options to the limits', () => {
    const options = { citingDepth: 3, citedDepth: 1, limit: 100, maxNodes: 300 };
    expect(clampOptions(options, ANONYMOUS.limits)).toBe(options);
    expect(clampOptions(options, { depth: 2, perNode: 50, maxNodes: 2000 })).toEqual({
      citingDepth: 2,
      citedDepth: 1,
      limit: 50,
      maxNodes: 300,
    });
  });
});

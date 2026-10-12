import { describe, expect, it } from 'vitest';
import { layoutSpread } from './spacing.js';

describe('layoutSpread', () => {
  it('keeps the base spacing for small graphs', () => {
    expect(layoutSpread(0)).toBe(1);
    expect(layoutSpread(41)).toBe(1);
    expect(layoutSpread(60)).toBe(1);
  });

  it('grows with the square root of the number of works, in steps', () => {
    expect(layoutSpread(240)).toBe(2); // √(240 / 60) = 2
    expect(layoutSpread(408)).toBe(2.5); // √6.8 ≈ 2.61
    expect(layoutSpread(960)).toBe(4);
  });

  it('does not change for a small expansion', () => {
    expect(layoutSpread(380)).toBe(layoutSpread(400)); // Both round to 2.5.
  });
});

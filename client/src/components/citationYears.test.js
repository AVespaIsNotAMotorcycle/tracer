import { describe, expect, it } from 'vitest';
import { fillYears } from './citationYears.js';

describe('fillYears', () => {
  it('fills the years between the first and last with zeros', () => {
    expect(
      fillYears([
        { year: 1971, count: 2 },
        { year: 1974, count: 1 },
      ]),
    ).toEqual([
      { year: 1971, count: 2 },
      { year: 1972, count: 0 },
      { year: 1973, count: 0 },
      { year: 1974, count: 1 },
    ]);
    expect(fillYears([])).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeDoi, normalizeLanguage } from './ids.js';

describe('normalizeDoi', () => {
  it.each([
    ['10.7717/peerj.4375', '10.7717/peerj.4375'],
    ['https://doi.org/10.7717/PeerJ.4375', '10.7717/peerj.4375'],
    ['http://dx.doi.org/10.7717/peerj.4375', '10.7717/peerj.4375'],
    ['doi:10.7717/peerj.4375', '10.7717/peerj.4375'],
    ['  10.7717/peerj.4375  ', '10.7717/peerj.4375'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDoi(input)).toBe(expected);
  });

  it.each([null, undefined, '', 'W2741809807', 'not a doi'])('returns null for %s', (input) => {
    expect(normalizeDoi(input)).toBeNull();
  });
});

describe('normalizeLanguage', () => {
  it('keeps the lowercase primary subtag of a language tag', () => {
    expect(normalizeLanguage('fr')).toBe('fr');
    expect(normalizeLanguage('zh-CN')).toBe('zh');
    expect(normalizeLanguage(' EN_us ')).toBe('en');
    expect(normalizeLanguage('eng')).toBe('eng');
  });

  it('returns null for anything else', () => {
    expect(normalizeLanguage(null)).toBeNull();
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage('english')).toBeNull();
    expect(normalizeLanguage(42)).toBeNull();
  });
});

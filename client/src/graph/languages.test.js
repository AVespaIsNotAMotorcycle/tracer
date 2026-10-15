import { describe, expect, it } from 'vitest';
import { langFor, languageKey, languageName, scriptLabel, UNKNOWN_LANGUAGE } from './languages.js';

describe('languages', () => {
  it('keys works by language code, or unknown', () => {
    expect(languageKey({ language: 'fr' })).toBe('fr');
    expect(languageKey({ language: null })).toBe(UNKNOWN_LANGUAGE);
    expect(languageKey({})).toBe(UNKNOWN_LANGUAGE);
  });

  it('names languages in English', () => {
    expect(languageName('fr')).toBe('French');
    expect(languageName('zh')).toBe('Chinese');
    expect(languageName(UNKNOWN_LANGUAGE)).toBe('Unknown language');
  });

  it('labels scripts and picks a lang for CJK text', () => {
    expect(scriptLabel('han')).toBe('Chinese characters');
    expect(scriptLabel('other')).toBeNull();
    expect(langFor('han', 'ja')).toBe('ja');
    expect(langFor('han', 'en')).toBe('zh');
    expect(langFor('hangul', null)).toBe('ko');
    expect(langFor('latin', 'fr')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { chooseLanguage, otherTitles, scriptOf } from './titles.js';

describe('scriptOf', () => {
  it('names the script most letters are in', () => {
    expect(scriptOf('The Moral Economy')).toBe('latin');
    expect(scriptOf('满洲与汉人')).toBe('han');
    expect(scriptOf('日本の歴史')).toBe('japanese');
    expect(scriptOf('한국사')).toBe('hangul');
    expect(scriptOf('История России, 1900')).toBe('cyrillic');
    expect(scriptOf('1900–2000')).toBeNull();
  });
});

describe('otherTitles', () => {
  it('lists the original title, and the deposited title in another script', () => {
    expect(
      otherTitles('Qingdai Manzhou shi', { title: '清代满洲史', originalTitle: null }),
    ).toEqual([{ title: '清代满洲史', kind: 'alternate', script: 'han' }]);
    expect(
      otherTitles('The Making of Modern Japan', {
        title: 'The making of modern Japan',
        originalTitle: '近代日本の形成',
      }),
    ).toEqual([{ title: '近代日本の形成', kind: 'original', script: 'japanese' }]);
  });

  it('leaves out titles that only differ in form, and same-script ones', () => {
    expect(
      otherTitles('The Moral Economy', {
        title: 'Moral economy.',
        originalTitle: 'The moral economy',
      }),
    ).toEqual([]);
    expect(
      otherTitles('The Moral Economy', { title: 'A Different Title', originalTitle: null }),
    ).toEqual([]);
    expect(otherTitles('The Moral Economy', null)).toEqual([]);
  });
});

describe('chooseLanguage', () => {
  it('prefers the detected language, falling back on the deposited one', () => {
    expect(chooseLanguage('Histoire de France', 'fr', 'en')).toEqual({
      language: 'fr',
      from: 'detected',
    });
    expect(chooseLanguage('Histoire de France', null, 'fr')).toEqual({
      language: 'fr',
      from: 'deposited',
    });
    expect(chooseLanguage('Histoire', 'fr', null)).toEqual({ language: 'fr', from: 'detected' });
    expect(chooseLanguage('Histoire', null, null)).toEqual({ language: null, from: null });
  });

  it('takes the deposited language when only it fits the title’s script', () => {
    // As the Chinese Science Bulletin deposits: "en" for a Chinese title.
    expect(chooseLanguage('中国满洲里-绥芬河热流断面', 'zh', 'en')).toEqual({
      language: 'zh',
      from: 'detected',
    });
    expect(chooseLanguage('中国满洲里-绥芬河热流断面', 'en', 'zh')).toEqual({
      language: 'zh',
      from: 'deposited',
    });
    expect(chooseLanguage('История России', 'en', 'ru')).toEqual({
      language: 'ru',
      from: 'deposited',
    });
  });
});

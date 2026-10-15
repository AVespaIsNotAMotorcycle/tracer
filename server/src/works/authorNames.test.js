import { describe, expect, it } from 'vitest';
import { matchAuthors, otherNames, personLinks, sameName } from './authorNames.js';

const person = (id, fields = {}) => ({
  id,
  labels: {},
  aliases: [],
  nativeNames: [],
  kanaReadings: [],
  languages: [],
  orcid: null,
  viaf: null,
  ...fields,
});

const maruyama = person('Q1143571', {
  labels: { en: 'Masao Maruyama', ja: '丸山眞男', ko: '마루야마 마사오' },
  nativeNames: [{ text: '丸山眞男', language: 'ja' }],
  kanaReadings: ['まるやま まさお'],
  viaf: '44407375',
});
// Labels in other languages are transliterations of an English name.
const thompson = person('Q434160', {
  labels: { en: 'E. P. Thompson', ja: 'エドワード・P・トムスン', ru: 'Эдвард Палмер Томпсон' },
  nativeNames: [{ text: 'Edward Palmer Thompson', language: 'en' }],
  viaf: '18196',
});

describe('sameName', () => {
  it('matches surnames in either order, and the same characters in other scripts', () => {
    expect(sameName('E. P. Thompson', 'Edward Palmer Thompson')).toBe(true);
    expect(sameName('Maruyama Masao', 'Masao Maruyama')).toBe(true);
    expect(sameName('春凤 杨', '杨春凤')).toBe(true);
    expect(sameName('E. P. Thompson', 'Dorothy Smith')).toBe(false);
    expect(sameName('Masao Maruyama', '丸山眞男')).toBe(false);
    expect(sameName('杨春凤', '杨春')).toBe(false);
  });
});

describe('matchAuthors', () => {
  it('matches by ORCID, then credited authors whose names agree, each person once', () => {
    const authors = [
      { name: 'Masao Maruyama', orcid: null },
      { name: 'A. Colleague', orcid: '0000-0001-2345-6789' },
      { name: 'E. P. Thompson', orcid: null },
    ];
    const colleague = person('Q7', { orcid: '0000-0001-2345-6789', labels: { en: 'Someone' } });
    const credits = [
      { id: 'Q434160', ordinal: 3, statedAs: null },
      { id: 'Q1143571', ordinal: 1, statedAs: 'M. Maruyama' },
    ];
    const matches = matchAuthors(authors, credits, [maruyama, thompson, colleague]);
    expect([...matches].map(([index, p]) => [index, p.id])).toEqual([
      [1, 'Q7'],
      [0, 'Q1143571'],
      [2, 'Q434160'],
    ]);
  });

  it('doesn’t match a credited author whose name disagrees', () => {
    const matches = matchAuthors(
      [{ name: 'Dorothy Thompson', orcid: null }],
      [{ id: 'Q1143571', ordinal: 1, statedAs: null }],
      [maruyama],
    );
    expect(matches.size).toBe(0);
  });
});

describe('otherNames', () => {
  it('gives a romanized name’s native script, with its kana reading', () => {
    expect(otherNames('Masao Maruyama', maruyama)).toEqual([
      { text: '丸山眞男', language: 'ja', reading: 'まるやま まさお', kind: 'native' },
    ]);
  });

  it('gives a romanization of a name shown in its own script', () => {
    expect(otherNames('丸山眞男', maruyama)).toEqual([
      { text: 'Masao Maruyama', language: 'en', reading: null, kind: 'romanized' },
    ]);
  });

  it('shows no transliterations of a name already in its own script', () => {
    expect(otherNames('E. P. Thompson', thompson)).toEqual([]);
  });

  it('falls back on a label in their country’s language, if in its script', () => {
    // As bots create researchers' items: a label, citizenship, no native name.
    const nagasawa = person('Q27429849', {
      labels: { en: 'Kazuya Nagasawa', ja: '長澤和也' },
      countryLanguages: ['ja'],
    });
    expect(otherNames('Kazuya NAGASAWA', nagasawa)).toEqual([
      { text: '長澤和也', language: 'ja', reading: null, kind: 'native' },
    ]);
    const transliterated = person('Q2', {
      labels: { en: 'John Smith', ja: 'ジョン・スミス' },
      countryLanguages: ['ja'],
    });
    expect(otherNames('John Smith', transliterated)).toEqual([]);
  });

  it('falls back on the label in the language they wrote in', () => {
    const scholar = person('Q1', { labels: { en: 'Li Bo', zh: '李博' }, languages: ['zh'] });
    expect(otherNames('Li Bo', scholar)).toEqual([
      { text: '李博', language: 'zh', reading: null, kind: 'native' },
    ]);
  });
});

describe('personLinks', () => {
  it('links Wikidata, and VIAF when known', () => {
    expect(personLinks(maruyama)).toEqual([
      { kind: 'wikidata', url: 'https://www.wikidata.org/wiki/Q1143571' },
      { kind: 'viaf', url: 'https://viaf.org/viaf/44407375' },
    ]);
  });
});

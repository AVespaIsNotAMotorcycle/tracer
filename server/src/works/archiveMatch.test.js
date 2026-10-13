import { describe, expect, it } from 'vitest';
import {
  matchArchiveItems,
  matchArchiveItemsInText,
  printedSearchWords,
  searchWords,
} from './archiveMatch.js';
import { mainTitle, surname } from './textMatch.js';

const item = (identifier, title, creators = [], overrides = {}) => ({
  identifier,
  title,
  creators,
  year: null,
  access: 'borrow',
  url: `https://archive.org/details/${identifier}`,
  ...overrides,
});

describe('mainTitle', () => {
  it.each([
    ['Manchus & Han : ethnic relations', 'manchusandhan'],
    ['Manchus and Han - Ethnic Relations', 'manchusandhan'],
    [
      'The making of the English working class (Pelican books, A1000)',
      'makingoftheenglishworkingclass',
    ],
    ['The making of the English working class. --', 'makingoftheenglishworkingclass'],
    ['Geschichte von Japan / von O. Nachod', 'geschichtevonjapan'],
  ])('%s', (title, main) => {
    expect(mainTitle(title)).toBe(main);
  });
});

describe('searchWords', () => {
  it('searches on the main title’s distinctive words, without accents', () => {
    expect(searchWords('The Making of the English Working Class: A Study')).toEqual([
      'making',
      'english',
      'working',
      'class',
    ]);
    expect(searchWords('Histoire de l’État')).toEqual(['histoire', 'etat']);
  });
});

describe('matchArchiveItems', () => {
  const thompson = {
    title: 'The Making of the English Working Class',
    authors: [{ name: 'E. P. Thompson' }],
    year: 1963,
  };

  it('matches editions by main title and the first author’s surname, best first', () => {
    const matches = matchArchiveItems(thompson, [
      item(
        'pelican',
        'The making of the English working class (Pelican books)',
        ['E. P Thompson'],
        {
          year: 1968,
        },
      ),
      item('first', 'The making of the English working class', ['Thompson, E. P.'], { year: 1963 }),
      item('scan', 'The making of the English working class', ['Thompson, E. P.'], {
        year: 1980,
        access: 'open',
      }),
      item('other-author', 'The making of the English working class', ['Smith, J.']),
      item('other-title', 'The making of the English middle class', ['Thompson, E. P.']),
    ]);
    expect(matches.map((m) => m.identifier)).toEqual(['scan', 'first', 'pelican']);
  });

  it('accepts an item without creators only on a whole, long title', () => {
    const rhoads = {
      title: 'Manchus and Han: Ethnic Relations and Political Power in Late Qing China',
      authors: [{ name: 'Edward J. M. Rhoads' }],
      year: 2001,
    };
    const matches = matchArchiveItems(rhoads, [
      item('oapen', 'Manchus and Han - Ethnic Relations and Political Power in Late Qing China'),
      item('short', 'Manchus and Han'),
    ]);
    expect(matches.map((m) => m.identifier)).toEqual(['oapen']);
  });

  it('needs an author to match a short title', () => {
    const japan = { title: 'Japan', authors: [], year: 1990 };
    expect(matchArchiveItems(japan, [item('japan', 'Japan', ['Smith, J.'])])).toEqual([]);
    expect(matchArchiveItems({ title: null, authors: [], year: null }, [item('x', '')])).toEqual(
      [],
    );
  });
});

describe('surname', () => {
  it.each([
    ['E. P. Thompson', 'thompson'],
    ['Thompson, E. P.', 'thompson'],
    ['Fox E.W.', 'fox'],
    ['Whiting Fox', 'fox'],
    ['Zebrowski', 'zebrowski'],
  ])('%s', (name, expected) => {
    expect(surname(name)).toBe(expected);
  });
});

describe('citations printed as text', () => {
  const slicher =
    'B.H. Slicher van Bath, The Agrarian History of Western Europe, A.D. 500–1850, (London, 1963), pp. 207–208.';

  it('searches on the distinctive words, without places, pages or numbers', () => {
    expect(printedSearchWords(slicher)).toEqual([
      'slicher',
      'van',
      'bath',
      'agrarian',
      'history',
      'western',
      'europe',
    ]);
    expect(printedSearchWords('Ibid., p. 173.')).toEqual([]);
  });

  it('matches items whose title and a creator both appear in the text', () => {
    const matches = matchArchiveItemsInText(slicher, 1963, [
      item(
        'later',
        'The agrarian history of Western Europe, A.D. 500-1850',
        ['B.H. Slicher Van Bath'],
        { year: 1966 },
      ),
      item(
        'first',
        'The agrarian history of Western Europe : A.D. 500-1850',
        ['Slicher van Bath, B. H'],
        { year: 1963 },
      ),
      item('other-author', 'The agrarian history of Western Europe', ['Smith, J.']),
      item('no-creator', 'The agrarian history of Western Europe'),
      item('other-title', 'Agrarian conditions in modern European history', ['Warner, Charles K.']),
      // A short title found in the text by chance.
      item('short', 'Europe', ['Bath, A.']),
    ]);
    expect(matches.map((m) => m.identifier)).toEqual(['first', 'later']);
  });
});

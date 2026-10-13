import { describe, expect, it } from 'vitest';
import { citationQuery, doiLinks, matchCitation } from './citationMatch.js';

const reference = (fields) => ({
  doi: null,
  title: null,
  authors: [],
  year: null,
  venue: null,
  unstructured: null,
  ...fields,
});

const candidate = (doi, title, families = [], year = null) => ({
  doi,
  title,
  authors: families.map((family) => ({ name: `A. ${family}`, family })),
  year,
  type: 'journal-article',
  venue: null,
  url: null,
});

describe('citationQuery', () => {
  it('searches the citation as printed, or its fields', () => {
    expect(citationQuery(reference({ unstructured: 'Hobsbawm, The Machine Breakers' }))).toBe(
      'Hobsbawm, The Machine Breakers',
    );
    expect(
      citationQuery(
        reference({ title: 'Deccani Painting', authors: [{ name: 'Zebrowski' }], year: 1983 }),
      ),
    ).toBe('Zebrowski Deccani Painting 1983');
    expect(citationQuery(reference({ authors: [{ name: 'Zebrowski' }] }))).toBeNull();
  });
});

describe('doiLinks', () => {
  it('adds JSTOR’s page for a JSTOR DOI', () => {
    expect(doiLinks('10.2307/2942138')).toEqual([
      { kind: 'doi', url: 'https://doi.org/10.2307/2942138' },
      { kind: 'jstor', url: 'https://www.jstor.org/stable/10.2307/2942138' },
    ]);
    expect(doiLinks('10.1093/past/1.1.57').map((link) => link.kind)).toEqual(['doi']);
  });
});

describe('matchCitation', () => {
  const deccani = reference({
    title: 'Deccani Painting',
    authors: [{ name: 'Zebrowski' }],
    year: 1983,
  });

  it('matches by title, first author and year', () => {
    const match = matchCitation(deccani, [
      candidate('10.1/entry', 'Indian subcontinent: Deccani and South Indian painting', [
        'Dallapiccola',
      ]),
      // Reviews of the book share its title, but not its author.
      candidate('10.2307/601736', 'Deccani Painting', ['Schimmel'], 1985),
      { ...candidate('10.1/book', 'Deccani painting.', ['Zebrowski'], 1983), type: 'book' },
    ]);
    expect(match?.doi).toBe('10.1/book');
  });

  it('refuses reviews of a book: journal articles, reviewer first, or no authors', () => {
    const fogel = reference({
      title: 'Time on the Cross. The Economics of American Negro Slavery',
      authors: [{ name: 'Fogel' }],
      year: 1974,
    });
    // As JSTOR records a review: the reviewer, then the book's authors.
    const jstorReview = candidate(
      '10.2307/40023297',
      'Time on the Cross: The Economics of American Negro Slavery',
      ['Shub', 'Fogel', 'Engerman'],
      1974,
    );
    expect(matchCitation(fogel, [jstorReview])).toBeNull();
    // Even if it weren't a journal article, the book's author isn't first.
    expect(matchCitation(fogel, [{ ...jstorReview, type: 'book' }])).toBeNull();
    const choice = {
      ...candidate('10.5860/choice.1', 'Time on the Cross', [], 1975),
      type: 'other',
    };
    expect(matchCitation(fogel, [choice])).toBeNull();
    const book = {
      ...candidate(
        '10.1/book',
        'Time on the Cross: The Economics of American Negro Slavery',
        ['Fogel', 'Engerman'],
        1974,
      ),
      type: 'book',
    };
    expect(matchCitation(fogel, [jstorReview, choice, book])?.doi).toBe('10.1/book');
  });

  it('matches an edited book by its editor', () => {
    const edited = reference({
      title: 'Exploring the Dutch Empire',
      authors: [{ name: 'Antunes C.' }],
      year: 2015,
    });
    const found = {
      ...candidate(
        '10.5040/9781474236454',
        'Exploring the Dutch Empire: Agents, Networks and Institutions',
        ['Antunes'],
        2015,
      ),
      type: 'edited-book',
    };
    expect(matchCitation(edited, [found])?.doi).toBe('10.5040/9781474236454');
  });

  it('compares surnames with particles, but not short ones by ending', () => {
    const vries = reference({
      title: 'The First Modern Economy',
      authors: [{ name: 'Vries' }],
      venue: 'X',
      year: 1997,
    });
    expect(
      matchCitation(vries, [candidate('10.1/a', 'The First Modern Economy', ['de Vries'], 1997)])
        ?.doi,
    ).toBe('10.1/a');
    const li = reference({
      title: 'Silk and Empire',
      authors: [{ name: 'Li' }],
      venue: 'X',
      year: 2001,
    });
    expect(matchCitation(li, [candidate('10.1/b', 'Silk and Empire', ['Bali'], 2001)])).toBeNull();
  });

  it('refuses a year more than one off', () => {
    expect(
      matchCitation(deccani, [candidate('10.1/later', 'Deccani Painting', ['Zebrowski'], 1990)]),
    ).toBeNull();
  });

  it('finds the title and author in a citation printed as text', () => {
    const printed = reference({
      unstructured: "Hobsbawm, E. J. 'The Machine Breakers.' Past and Present 1 (1952): 57-70.",
      year: 1952,
    });
    expect(
      matchCitation(printed, [
        candidate('10.1/other', 'Victor Kiernan', ['Hobsbawm'], 2010),
        candidate('10.1093/past/1.1.57', 'The Machine Breakers', ['Hobsbawm'], 1952),
      ])?.doi,
    ).toBe('10.1093/past/1.1.57');
    // A short title found inside the text by chance doesn't count.
    const short = reference({
      unstructured: 'Smith, J. Essays on Japan. Tokyo, 1990.',
      year: 1990,
    });
    expect(matchCitation(short, [candidate('10.1/japan', 'Japan', ['Smith'], 1990)])).toBeNull();
  });

  it('trusts a candidate without authors only on a long title and an agreeing year', () => {
    const long = reference({ title: 'Ethnic Relations and Political Power', year: 2000 });
    const book = (doi, title, families, year) => ({
      ...candidate(doi, title, families, year),
      type: 'book',
    });
    expect(
      matchCitation(long, [book('10.1/a', 'Ethnic relations and political power', [], 2000)])?.doi,
    ).toBe('10.1/a');
    expect(
      matchCitation({ ...long, year: null }, [
        book('10.1/a', 'Ethnic relations and political power', [], 2000),
      ]),
    ).toBeNull();
  });
});

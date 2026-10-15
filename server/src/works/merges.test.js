import { describe, expect, it } from 'vitest';
import { sameWork } from './merges.js';

const record = (fields = {}) => ({
  title: 'The Making of the English Working Class',
  authors: [{ name: 'E. P. Thompson' }],
  year: 1963,
  type: 'book',
  ...fields,
});

describe('sameWork', () => {
  it('matches records of one work formatted differently', () => {
    expect(sameWork(record(), record({ title: 'The making of the English working class.' }))).toBe(
      true,
    );
    expect(sameWork(record(), record({ authors: [{ name: 'Thompson, Edward Palmer' }] }))).toBe(
      true,
    );
    expect(sameWork(record(), record({ year: 1964 }))).toBe(true);
    // Cited without its subtitle.
    expect(
      sameWork(
        record({ title: 'Whigs and Hunters: The Origin of the Black Act', year: 1975 }),
        record({ title: 'Whigs and Hunters', year: 1975 }),
      ),
    ).toBe(true);
    // Crossref's type names, and records without authors.
    expect(sameWork(record({ type: 'monograph' }), record({ authors: [] }))).toBe(true);
  });

  it('refuses reviews, chapters and other kinds of record with the same title', () => {
    expect(sameWork(record(), record({ type: 'review' }))).toBe(false);
    expect(sameWork(record(), record({ type: 'article' }))).toBe(false);
    expect(sameWork(record({ type: 'article' }), record({ type: 'erratum' }))).toBe(false);
    expect(sameWork(record({ type: 'article' }), record({ type: 'journal-article' }))).toBe(true);
  });

  it('refuses different titles, years more than one apart, or different authors', () => {
    expect(sameWork(record(), record({ title: 'The Poverty of Theory' }))).toBe(false);
    expect(sameWork(record(), record({ year: 1968 }))).toBe(false);
    expect(sameWork(record(), record({ authors: [{ name: 'A. Reviewer' }] }))).toBe(false);
    // A short main title isn't enough on its own.
    expect(sameWork(record({ title: 'Japan: A History' }), record({ title: 'Japan' }))).toBe(false);
  });

  it('needs both titles unless told the records share a DOI', () => {
    expect(sameWork(record(), record({ title: null }))).toBe(false);
    expect(sameWork(record(), record({ title: null }), { requireTitles: false })).toBe(true);
    expect(sameWork(record(), record({ title: 'Something Else' }), { requireTitles: false })).toBe(
      false,
    );
  });
});

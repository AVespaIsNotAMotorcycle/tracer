import { describe, expect, it } from 'vitest';
import {
  groupByProviders,
  describeWarning,
  graphLinks,
  referenceWarning,
  referenceWarnings,
} from './provenance.js';

const work = (id, fields = {}) => ({
  id,
  type: 'article',
  citedByCount: 0,
  references: [],
  providers: ['openalex'],
  ...fields,
});

describe('graphLinks', () => {
  it('lists a work’s citations on the graph with their providers, unknown when not sent', () => {
    const works = new Map(
      [
        work('a', {
          references: ['b', 'c', 'off-graph'],
          referenceProviders: { b: ['openalex', 'crossref'], c: ['crossref'] },
        }),
        work('b'),
        work('c'),
        work('d', { references: ['a'], referenceProviders: { a: ['opencitations'] } }),
        // From an older snapshot: no providers recorded.
        work('e', { references: ['a'] }),
      ].map((w) => [w.id, w]),
    );
    const links = graphLinks(works, 'a');
    expect(links.map(({ work: w, direction, providers }) => [w.id, direction, providers])).toEqual([
      ['b', 'cites', ['openalex', 'crossref']],
      ['c', 'cites', ['crossref']],
      ['d', 'cited-by', ['opencitations']],
      ['e', 'cited-by', []],
    ]);
    // Each link counts once, in the group of exactly the providers that have it.
    expect(groupByProviders(links)).toEqual([
      { providers: ['openalex', 'crossref'], count: 1 },
      { providers: ['crossref'], count: 1 },
      { providers: ['opencitations'], count: 1 },
      { providers: [], count: 1 },
    ]);
    expect(
      groupByProviders([
        { providers: ['crossref', 'openalex'] },
        { providers: ['openalex', 'crossref'] },
        { providers: ['openalex'] },
      ]),
    ).toEqual([
      { providers: ['openalex', 'crossref'], count: 2 },
      { providers: ['openalex'], count: 1 },
    ]);
  });
});

describe('referenceWarning', () => {
  it('flags a much-cited work with no references, or very few', () => {
    expect(referenceWarning(work('t', { citedByCount: 4693 }))).toEqual({
      kind: 'none',
      references: 0,
      citedByCount: 4693,
      checked: ['openalex'],
    });
    expect(
      referenceWarning(work('t', { citedByCount: 250, references: ['x', 'y'] })),
    ).toMatchObject({ kind: 'few', references: 2 });
  });

  it('leaves alone works cited little, with enough references, or that needn’t cite', () => {
    expect(referenceWarning(work('t', { citedByCount: 9 }))).toBeNull();
    expect(referenceWarning(work('t', { citedByCount: 99, references: ['x'] }))).toBeNull();
    expect(
      referenceWarning(work('t', { citedByCount: 500, references: ['1', '2', '3', '4', '5'] })),
    ).toBeNull();
    expect(referenceWarning(work('t', { citedByCount: 500, type: 'book-review' }))).toBeNull();
    expect(referenceWarning(work('t', { citedByCount: 500, type: 'dataset' }))).toBeNull();
    expect(referenceWarning(work('t', { citedByCount: null, type: 'reference-only' }))).toBeNull();
  });

  it('collects warnings by work and describes them', () => {
    const works = new Map([
      ['a', work('a', { citedByCount: 40, providers: ['openalex', 'crossref'] })],
      ['b', work('b')],
    ]);
    const warnings = referenceWarnings(works);
    expect([...warnings.keys()]).toEqual(['a']);
    expect(describeWarning(warnings.get('a'))).toBe(
      'No references are recorded for this work in OpenAlex and Crossref, though 40 works cite it. Its own citations are missing from the data, so it can look like a starting point on the graph without being one.',
    );
    expect(
      describeWarning({ kind: 'few', references: 1, citedByCount: 1200, checked: ['openalex'] }),
    ).toBe(
      'Only 1 reference is recorded for this work in OpenAlex, though 1,200 works cite it, so most of its own citations are probably missing.',
    );
  });
});

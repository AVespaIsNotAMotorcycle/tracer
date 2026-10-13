import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPTIONS,
  readUrlState,
  shareableId,
  withSavedGraph,
  writeUrlState,
} from './urlState.js';

const work = (externalIds) => ({ id: '6acc5cc1be794979fbd4f13b', externalIds });

describe('shareableId', () => {
  it('prefers the DOI, then the OpenAlex ID, then the Tracer ID', () => {
    expect(shareableId(work({ openalex: 'W1', doi: '10.1093/past/50.1.76' }))).toBe(
      '10.1093/past/50.1.76',
    );
    expect(shareableId(work({ openalex: 'W1' }))).toBe('W1');
    expect(shareableId(work({}))).toBe('6acc5cc1be794979fbd4f13b');
  });
});

describe('readUrlState', () => {
  it('reads the anchor and options', () => {
    expect(readUrlState('?anchor=10.1093%2Fpast%2F50.1.76&cited=2&perNode=50')).toEqual({
      anchor: '10.1093/past/50.1.76',
      options: { ...DEFAULT_OPTIONS, citedDepth: 2, limit: 50 },
      graph: null,
    });
  });

  it('defaults when parameters are missing', () => {
    expect(readUrlState('')).toEqual({ anchor: null, options: DEFAULT_OPTIONS, graph: null });
  });

  it.each(['cited=9', 'cited=-1', 'cited=1.5', 'cited=abc', 'max=5', 'perNode=500'])(
    'ignores out-of-range %s',
    (query) => {
      expect(readUrlState(`?anchor=W1&${query}`).options).toEqual(DEFAULT_OPTIONS);
    },
  );
});

describe('writeUrlState', () => {
  it('writes the anchor and only non-default options', () => {
    const search = writeUrlState('', work({ doi: '10.1/x', openalex: 'W1' }), {
      ...DEFAULT_OPTIONS,
      citedDepth: 2,
    });
    expect(search).toBe('?anchor=10.1%2Fx&cited=2');
  });

  it('removes options that return to their defaults, keeping unrelated parameters', () => {
    const search = writeUrlState(
      '?automation=1&anchor=W9&cited=2',
      work({ openalex: 'W1' }),
      DEFAULT_OPTIONS,
    );
    expect(search).toBe('?automation=1&anchor=W1');
  });

  it('round-trips through readUrlState', () => {
    const options = { citingDepth: 0, citedDepth: 3, limit: 40, maxNodes: 500 };
    const search = writeUrlState('', work({ doi: '10.1093/past/50.1.76' }), options);
    expect(readUrlState(search)).toEqual({ anchor: '10.1093/past/50.1.76', options, graph: null });
  });
});

describe('saved graphs in the URL', () => {
  it('reads a saved graph’s ID', () => {
    expect(readUrlState('?graph=abc123').graph).toBe('abc123');
  });

  it('adds one to the URL, keeping the rest', () => {
    expect(withSavedGraph('?anchor=W1&automation', 'abc123')).toBe(
      '?anchor=W1&automation=&graph=abc123',
    );
  });

  it('drops it when a new run writes the URL', () => {
    const next = writeUrlState(
      '?graph=abc123',
      { id: 't', externalIds: { openalex: 'W2' } },
      DEFAULT_OPTIONS,
    );
    expect(readUrlState(next).graph).toBeNull();
    expect(readUrlState(next).anchor).toBe('W2');
  });
});

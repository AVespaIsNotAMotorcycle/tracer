import { describe, expect, it, vi } from 'vitest';
import {
  addWorks,
  buildGraph,
  deriveEdges,
  emptyGraph,
  expandWork,
  inGraphCitationCounts,
  NO_FILTERS,
  visibleIds,
} from './graphModel.js';

const work = (id, references = [], year = 2000) => ({ id, references, year, title: id });

const worksMap = (...works) => new Map(works.map((w) => [w.id, w]));

/**
 * A fake API over a citation network given as { id: [ids it cites] }. Citing lists are
 * derived by inverting it.
 */
function fakeApi(network, years = {}) {
  const make = (id) => work(id, network[id] ?? [], years[id] ?? 2000);
  return {
    getWork: vi.fn(async (id) => make(id)),
    getCited: vi.fn(async (id, { limit }) => (network[id] ?? []).slice(0, limit).map(make)),
    getCiting: vi.fn(async (id, { limit }) =>
      Object.keys(network)
        .filter((other) => network[other].includes(id))
        .slice(0, limit)
        .map(make),
    ),
  };
}

describe('deriveEdges', () => {
  it('includes citations between any two works on the graph', () => {
    const works = worksMap(work('R', ['A']), work('A', ['B']), work('B'), work('C', ['A', 'X']));

    expect(deriveEdges(works)).toEqual([
      { source: 'R', target: 'A' },
      { source: 'A', target: 'B' },
      { source: 'C', target: 'A' },
    ]);
  });

  it('ignores self-citations and duplicate references', () => {
    expect(deriveEdges(worksMap(work('A', ['A', 'B', 'B']), work('B')))).toEqual([
      { source: 'A', target: 'B' },
    ]);
  });
});

describe('inGraphCitationCounts', () => {
  it('counts citations from works on the graph only', () => {
    const counts = inGraphCitationCounts(
      worksMap(work('A', ['C', 'X']), work('B', ['C']), work('C')),
    );

    expect(Object.fromEntries(counts)).toEqual({ A: 0, B: 0, C: 2 });
  });
});

describe('visibleIds', () => {
  const graph = {
    ...addWorks(
      emptyGraph(),
      [
        work('R', ['A', 'B'], 1971),
        work('A', [], 1950),
        work('B', [], 1990),
        work('C', ['A'], null),
      ],
      'cited',
    ),
    rootId: 'R',
  };
  const counts = inGraphCitationCounts(graph.works);

  it('shows everything with no filters', () => {
    expect(visibleIds(graph, NO_FILTERS, counts)).toEqual(new Set(['R', 'A', 'B', 'C']));
  });

  it('filters by year range, hiding works with no year', () => {
    const filters = { ...NO_FILTERS, minYear: 1960, maxYear: 2000 };
    expect(visibleIds(graph, filters, counts)).toEqual(new Set(['R', 'B']));
  });

  it('filters by in-graph citations but always keeps the root and pinned IDs', () => {
    const filters = { ...NO_FILTERS, minCitations: 2 };
    expect(visibleIds(graph, filters, counts, ['C'])).toEqual(new Set(['R', 'A', 'C']));
  });
});

describe('buildGraph', () => {
  // R cites A and B; A cites B; C and D cite R; E cites C.
  const network = { R: ['A', 'B'], A: ['B'], B: [], C: ['R'], D: ['R'], E: ['C'] };

  it('follows each direction to its own depth', async () => {
    const api = fakeApi(network);

    const { graph, truncated } = await buildGraph(
      'R',
      { citingDepth: 2, citedDepth: 1, limit: 10, maxNodes: 100 },
      api,
    );

    expect([...graph.works.keys()].sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'R']);
    expect(Object.fromEntries(graph.relations)).toEqual({
      R: 'root',
      C: 'citing',
      D: 'citing',
      E: 'citing',
      A: 'cited',
      B: 'cited',
    });
    expect(truncated).toBe(false);
    // Cited depth 1: A and B are never asked for their own references.
    expect(api.getCited).toHaveBeenCalledTimes(1);
  });

  it('records which directions were fetched for each work', async () => {
    const { graph } = await buildGraph(
      'R',
      { citingDepth: 1, citedDepth: 1, limit: 10, maxNodes: 100 },
      fakeApi(network),
    );

    expect(graph.expanded.get('R')).toEqual(new Set(['citing', 'cited']));
    expect(graph.expanded.has('A')).toBe(false);
  });

  it('applies the per-node limit', async () => {
    const { graph } = await buildGraph(
      'R',
      { citingDepth: 0, citedDepth: 1, limit: 1, maxNodes: 100 },
      fakeApi(network),
    );

    expect([...graph.works.keys()]).toEqual(['R', 'A']);
  });

  it('stops at maxNodes and reports truncation', async () => {
    const { graph, truncated } = await buildGraph(
      'R',
      { citingDepth: 3, citedDepth: 3, limit: 10, maxNodes: 3 },
      fakeApi(network),
    );

    expect(graph.works.size).toBe(3);
    expect(truncated).toBe(true);
  });

  it('alternates directions so maxNodes does not starve one', async () => {
    const { graph } = await buildGraph(
      'R',
      { citingDepth: 1, citedDepth: 1, limit: 10, maxNodes: 4 },
      fakeApi(network),
    );

    const relations = [...graph.relations.values()];
    expect(relations).toContain('citing');
    expect(relations).toContain('cited');
  });

  it('fetches each work at most once per direction', async () => {
    const api = fakeApi(network);

    await buildGraph('R', { citingDepth: 3, citedDepth: 3, limit: 10, maxNodes: 100 }, api);

    const citedIds = api.getCited.mock.calls.map(([id]) => id);
    expect(new Set(citedIds).size).toBe(citedIds.length);
  });

  it('reports progress as works arrive', async () => {
    const onProgress = vi.fn();

    await buildGraph(
      'R',
      { citingDepth: 1, citedDepth: 1, limit: 10, maxNodes: 100 },
      fakeApi(network),
      onProgress,
    );

    expect(onProgress.mock.calls[0][0].works.size).toBe(1);
    expect(onProgress.mock.calls.at(-1)[0].works.size).toBe(5);
  });

  it('uses the root ID the API returns', async () => {
    const api = fakeApi(network);
    api.getWork.mockResolvedValueOnce(work('R', ['A', 'B']));

    const { graph } = await buildGraph(
      '10.1234/root',
      { citingDepth: 0, citedDepth: 0, limit: 10, maxNodes: 100 },
      api,
    );

    expect(graph.rootId).toBe('R');
  });
});

describe('expandWork', () => {
  const network = { R: ['A'], A: ['B'], B: [], C: ['A'] };

  it('adds citing and cited works and marks the work expanded', async () => {
    const graph = {
      ...addWorks(emptyGraph(), [work('R', ['A']), work('A', ['B'])], 'cited'),
      rootId: 'R',
    };

    const apply = await expandWork(graph, 'A', { limit: 10 }, fakeApi(network));
    const next = apply(graph);

    expect([...next.works.keys()].sort()).toEqual(['A', 'B', 'C', 'R']);
    expect(next.relations.get('B')).toBe('cited');
    expect(next.relations.get('C')).toBe('citing');
    expect(next.relations.get('R')).toBe('cited'); // Existing relations are kept.
    expect(next.expanded.get('A')).toEqual(new Set(['citing', 'cited']));
  });

  it('skips directions already fetched', async () => {
    const api = fakeApi(network);
    const graph = {
      ...addWorks(emptyGraph(), [work('A', ['B'])], 'root'),
      expanded: new Map([['A', new Set(['cited'])]]),
    };

    await expandWork(graph, 'A', { limit: 10 }, api);

    expect(api.getCited).not.toHaveBeenCalled();
    expect(api.getCiting).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createProgressTracker } from './progress.js';
import {
  addWorks,
  buildGraph,
  deriveEdges,
  emptyGraph,
  expandWork,
  inGraphCitationCounts,
  layoutYears,
  reanchorGraph,
  NO_FILTERS,
  visibleIds,
  yearPositions,
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
    anchorId: 'R',
  };
  const counts = inGraphCitationCounts(graph.works);

  it('shows everything with no filters', () => {
    expect(visibleIds(graph, NO_FILTERS, counts)).toEqual(new Set(['R', 'A', 'B', 'C']));
  });

  it('filters by year range, hiding works with no year', () => {
    const filters = { ...NO_FILTERS, minYear: 1960, maxYear: 2000 };
    expect(visibleIds(graph, filters, counts)).toEqual(new Set(['R', 'B']));
  });

  it('filters by in-graph citations but always keeps the anchor and pinned IDs', () => {
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
      R: 'anchor',
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

  it('uses the anchor ID the API returns', async () => {
    const api = fakeApi(network);
    api.getWork.mockResolvedValueOnce(work('R', ['A', 'B']));

    const { graph } = await buildGraph(
      '10.1234/anchor',
      { citingDepth: 0, citedDepth: 0, limit: 10, maxNodes: 100 },
      api,
    );

    expect(graph.anchorId).toBe('R');
  });
});

describe('expandWork', () => {
  const network = { R: ['A'], A: ['B'], B: [], C: ['A'] };

  it('adds citing and cited works and marks the work expanded', async () => {
    const graph = {
      ...addWorks(emptyGraph(), [work('R', ['A']), work('A', ['B'])], 'cited'),
      anchorId: 'R',
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
      ...addWorks(emptyGraph(), [work('A', ['B'])], 'anchor'),
      expanded: new Map([['A', new Set(['cited'])]]),
    };

    await expandWork(graph, 'A', { limit: 10 }, api);

    expect(api.getCited).not.toHaveBeenCalled();
    expect(api.getCiting).toHaveBeenCalledTimes(1);
  });
});

describe('layoutYears', () => {
  /** Builds a graph from [id, references, year, relation] rows; the first row is the anchor. */
  const graphOf = (...rows) => {
    let graph = emptyGraph();
    for (const [id, references, year, relation] of rows) {
      graph = addWorks(graph, [work(id, references, year)], relation);
    }
    return { ...graph, anchorId: rows[0][0] };
  };
  const yearsOf = (graph) =>
    Object.fromEntries([...layoutYears(graph)].map(([id, { year }]) => [id, year]));

  it('uses publication years when known', () => {
    const graph = graphOf(['N', ['A'], 1971, 'anchor'], ['A', [], 1930, 'cited']);

    expect(layoutYears(graph).get('A')).toEqual({ year: 1930, inferred: false });
  });

  it('places undated works the anchor cites before the anchor', () => {
    const graph = graphOf(['N', ['U'], 1971, 'anchor'], ['U', [], null, 'cited']);

    expect(layoutYears(graph).get('U')).toEqual({ year: 1970, inferred: true });
  });

  it('places undated works citing the anchor after the anchor', () => {
    const graph = graphOf(['N', [], 1971, 'anchor'], ['U', ['N'], null, 'citing']);

    expect(yearsOf(graph).U).toBe(1972);
  });

  it('uses dated neighbors to place undated works more precisely', () => {
    // U is cited by the anchor (1971) and by B (1950), and cites C (1900).
    const graph = graphOf(
      ['N', ['U'], 1971, 'anchor'],
      ['U', ['C'], null, 'cited'],
      ['B', ['U'], 1950, 'cited'],
      ['C', [], 1900, 'cited'],
    );

    expect(yearsOf(graph).U).toBe(1925); // Between 1900 and 1950.
  });

  it('keeps the anchor rule even when neighbors suggest otherwise', () => {
    // U is cited by the anchor but cites a (misdated) 1990 work.
    const graph = graphOf(
      ['N', ['U'], 1971, 'anchor'],
      ['U', ['X'], null, 'cited'],
      ['X', [], 1990, 'cited'],
    );

    expect(yearsOf(graph).U).toBe(1970);
  });

  it('falls back on how undated works joined the graph', () => {
    // U and V are two levels out, with no dated neighbors of their own.
    const graph = graphOf(
      ['N', [], 1971, 'anchor'],
      ['U', [], null, 'cited'],
      ['V', [], null, 'citing'],
    );

    expect(yearsOf(graph)).toMatchObject({ U: 1970, V: 1972 });
  });

  it('infers an undated anchor from its neighbors', () => {
    const graph = graphOf(
      ['N', ['A'], null, 'anchor'],
      ['A', [], 1930, 'cited'],
      ['U', [], null, 'cited'],
    );

    expect(layoutYears(graph).get('N')).toEqual({ year: 1931, inferred: true });
    expect(yearsOf(graph).U).toBe(1930);
  });

  it('returns null when nothing is dated', () => {
    const graph = graphOf(['N', ['U'], null, 'anchor'], ['U', [], null, 'cited']);

    expect(yearsOf(graph)).toEqual({ N: null, U: null });
  });
});

describe('yearPositions', () => {
  it('orders years and centers them on 0', () => {
    const positions = yearPositions([2001, 2000, 2002, 2000], 10);

    expect([...positions]).toEqual([
      [2000, -10],
      [2001, 0],
      [2002, 10],
    ]);
  });

  it('gives long gaps more room, but less than proportionally', () => {
    const positions = yearPositions([1900, 1990, 1991], 10);
    const longGap = positions.get(1990) - positions.get(1900);
    const shortGap = positions.get(1991) - positions.get(1990);

    expect(longGap).toBeGreaterThan(shortGap * 5);
    expect(longGap).toBeLessThan(shortGap * 90);
  });

  it('handles no years', () => {
    expect(yearPositions([]).size).toBe(0);
  });
});

describe('reanchorGraph', () => {
  // R cites A and B; A cites D; B cites F; F cites G; C and E cite R and A respectively.
  const network = { R: ['A', 'B'], A: ['D'], B: ['F'], F: ['G'], D: [], G: [], C: ['R'], E: ['A'] };
  const ids = (graph) => [...graph.works.keys()].sort();
  const oldGraph = async (
    api,
    options = { citingDepth: 0, citedDepth: 2, limit: 10, maxNodes: 100 },
  ) => (await buildGraph('R', options, api)).graph;

  it('measures depth from the new anchor and drops what only the old build reached', async () => {
    const api = fakeApi(network);
    const before = await oldGraph(api); // R; A, B at depth 1; D, F at depth 2
    expect(ids(before)).toEqual(['A', 'B', 'D', 'F', 'R']);

    const { graph } = await reanchorGraph(
      before,
      'B',
      { citingDepth: 0, citedDepth: 2, limit: 10, maxNodes: 100 },
      api,
    );

    expect(graph.anchorId).toBe('B');
    // From B: F (depth 1), G (depth 2). Kept: R with its neighbors A, B, C. Dropped: D.
    expect(ids(graph)).toEqual(['A', 'B', 'C', 'F', 'G', 'R']);
  });

  it('keeps the previous anchor expanded and recolors it relative to the new anchor', async () => {
    const api = fakeApi(network);
    const before = await oldGraph(api);

    const { graph } = await reanchorGraph(
      before,
      'B',
      { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 },
      api,
    );

    expect(graph.relations.get('B')).toBe('anchor');
    expect(graph.relations.get('R')).toBe('citing'); // R cites B.
    expect(graph.expanded.get('R')).toEqual(new Set(['citing', 'cited']));
    expect(graph.sticky).toEqual(new Set(['R']));
  });

  it('keeps works the user expanded, with their neighbors', async () => {
    const api = fakeApi(network);
    let before = await oldGraph(api, { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 });
    before = (await expandWork(before, 'A', { limit: 10 }, api))(before); // adds D and E
    expect(before.sticky).toEqual(new Set(['A']));

    const { graph } = await reanchorGraph(
      before,
      'B',
      { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 },
      api,
    );

    expect(ids(graph)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'R']);
    expect(graph.sticky).toEqual(new Set(['A', 'R']));
  });

  it('carries sticky works through a chain of re-anchors', async () => {
    const api = fakeApi(network);
    const options = { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 };
    const first = await reanchorGraph(await oldGraph(api), 'B', options, api);

    const { graph } = await reanchorGraph(first.graph, 'F', options, api);

    expect(graph.anchorId).toBe('F');
    expect(graph.sticky).toEqual(new Set(['R', 'B']));
    expect(graph.works.has('G')).toBe(true);
  });

  it('does not refetch the new anchor', async () => {
    const api = fakeApi(network);
    const before = await oldGraph(api);
    api.getWork.mockClear();

    await reanchorGraph(
      before,
      'B',
      { citingDepth: 1, citedDepth: 1, limit: 10, maxNodes: 100 },
      api,
    );

    expect(api.getWork).not.toHaveBeenCalled();
  });

  it('rejects a work that is not on the graph', async () => {
    const api = fakeApi(network);
    await expect(
      reanchorGraph(
        await oldGraph(api),
        'Z',
        { citingDepth: 1, citedDepth: 1, limit: 10, maxNodes: 100 },
        api,
      ),
    ).rejects.toThrow(/not on the graph/);
  });
});

describe('progress reporting', () => {
  // R cites A and B; A cites D; B cites F; F cites G; C and E cite R and A respectively.
  const network = { R: ['A', 'B'], A: ['D'], B: ['F'], F: ['G'], D: [], G: [], C: ['R'], E: ['A'] };
  const record = () => {
    const snapshots = [];
    const tracker = createProgressTracker({ label: 'test', onChange: (s) => snapshots.push(s) });
    return { tracker, snapshots };
  };

  it('accounts for every request by the end of a build', async () => {
    const { tracker, snapshots } = record();

    const { graph } = await buildGraph(
      'R',
      { citingDepth: 1, citedDepth: 2, limit: 10, maxNodes: 100 },
      fakeApi(network),
      undefined,
      tracker,
    );

    const last = snapshots.at(-1);
    // 1 anchor lookup + citing(R) + cited(R) + cited(A) + cited(B).
    expect(last).toMatchObject({ done: 5, total: 5, estimated: false, works: graph.works.size });
    const dones = snapshots.map((s) => s.done);
    expect(dones).toEqual([...dones].sort((a, b) => a - b));
    expect(snapshots.every((s) => s.done <= s.total)).toBe(true);
  });

  it('projects deeper levels before they are reached', async () => {
    const { tracker, snapshots } = record();

    await buildGraph(
      'R',
      { citingDepth: 0, citedDepth: 3, limit: 10, maxNodes: 100 },
      fakeApi(network),
      undefined,
      tracker,
    );

    // Early on, later levels are only projected, so the total is an estimate.
    expect(snapshots.some((s) => s.estimated && s.total > s.done)).toBe(true);
    expect(snapshots.at(-1)).toMatchObject({ estimated: false });
    expect(snapshots.at(-1).done).toBe(snapshots.at(-1).total);
  });

  it('counts skipped requests when maxNodes is reached', async () => {
    const { tracker, snapshots } = record();

    await buildGraph(
      'R',
      { citingDepth: 3, citedDepth: 3, limit: 10, maxNodes: 3 },
      fakeApi(network),
      undefined,
      tracker,
    );

    expect(snapshots.at(-1).done).toBe(snapshots.at(-1).total);
    expect(snapshots.at(-1).works).toBe(3);
  });

  it('reports expansion requests, counting directions already fetched as done', async () => {
    const { tracker, snapshots } = record();
    const graph = {
      ...addWorks(emptyGraph(), [work('A', ['D'])], 'anchor'),
      expanded: new Map([['A', new Set(['cited'])]]),
    };
    tracker.plan(2);

    await expandWork(graph, 'A', { limit: 10 }, fakeApi(network), tracker);

    expect(snapshots.at(-1)).toMatchObject({ done: 2, total: 2, works: 2 }); // R and E cite A.
  });

  it('includes sticky expansions when re-anchoring', async () => {
    const api = fakeApi(network);
    const before = (
      await buildGraph('R', { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 }, api)
    ).graph;
    const { tracker, snapshots } = record();

    await reanchorGraph(
      before,
      'B',
      { citingDepth: 0, citedDepth: 1, limit: 10, maxNodes: 100 },
      api,
      undefined,
      tracker,
    );

    // 2 for sticky R + cited(B). The anchor is already loaded, so no lookup.
    expect(snapshots.at(-1)).toMatchObject({ done: 3, total: 3 });
  });
});

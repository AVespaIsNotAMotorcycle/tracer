import { describe, expect, it } from 'vitest';
import { addWorks, deriveEdges, emptyGraph, inGraphCitationCounts } from './graphModel.js';
import { applyManual, manualLinksOf, NO_MANUAL } from './manualOverlay.js';

const work = (id, references = [], extra = {}) => ({
  id,
  references,
  referenceProviders: Object.fromEntries(references.map((ref) => [ref, ['openalex']])),
  year: 2000,
  title: id,
  ...extra,
});

const built = () => {
  let graph = addWorks({ ...emptyGraph(), anchorIds: ['a'] }, [work('a', ['b'])], 'anchor');
  graph = addWorks(graph, [work('b')], 'cited');
  return addWorks(graph, [work('c', ['a'])], 'citing');
};

const manualData = (links, works = [], linkedWorks = []) => ({
  works: new Map(works.map((w) => [w.id, w])),
  links: links.map(([citingId, citedId], i) => ({ id: `l${i}`, citingId, citedId })),
  linkedWorks: new Map(linkedWorks.map((w) => [w.id, w])),
});

describe('applyManual', () => {
  it('leaves the graph alone with nothing added by hand', () => {
    const graph = built();
    expect(applyManual(graph, NO_MANUAL)).toBe(graph);
  });

  it('adds a citation between works on the graph, from the provider manual', () => {
    const graph = built();
    const shown = applyManual(graph, manualData([['b', 'c']]));
    expect(shown.works.get('b').references).toEqual(['c']);
    expect(shown.works.get('b').referenceProviders.c).toEqual(['manual']);
    expect(inGraphCitationCounts(shown.works).get('c')).toBe(1);
    // The graph itself, which builds and expansions use, is unchanged.
    expect(graph.works.get('b').references).toEqual([]);
  });

  it('marks a citation a provider has too as also the user’s', () => {
    const shown = applyManual(built(), manualData([['a', 'b']]));
    expect(shown.works.get('a').references).toEqual(['b']);
    expect(shown.works.get('a').referenceProviders.b).toEqual(['openalex', 'manual']);
  });

  it('brings in works linked to the graph, chains of them included', () => {
    const pamphlet = work('m1', [], { manual: true });
    const letter = work('m2', [], { manual: true });
    const outside = work('x');
    const shown = applyManual(
      built(),
      manualData(
        [
          ['b', 'm1'],
          ['m1', 'm2'],
          ['x', 'a'],
          ['m9', 'm8'],
        ],
        [pamphlet, letter],
        [outside],
      ),
    );
    expect([...shown.works.keys()].sort()).toEqual(['a', 'b', 'c', 'm1', 'm2', 'x']);
    expect(shown.relations.get('m1')).toBe('cited');
    expect(shown.relations.get('x')).toBe('citing');
    expect(deriveEdges(shown.works)).toContainEqual({ source: 'm1', target: 'm2' });
  });

  it('lists a work’s manual links with the other end', () => {
    const manual = manualData([
      ['a', 'm1'],
      ['x', 'a'],
      ['b', 'c'],
    ]);
    expect(
      manualLinksOf(manual, 'a').map(({ otherId, direction }) => [otherId, direction]),
    ).toEqual([
      ['m1', 'cites'],
      ['x', 'cited-by'],
    ]);
  });
});

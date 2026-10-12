// Pure citation-graph logic, independent of React and rendering.
//
// A graph holds works keyed by Tracer ID. Edges and in-graph citation counts are derived from
// each work's `references`, never stored, because they change whenever works are added.
// Filters decide what is visible; they never remove works from the graph.

/** @typedef {'citing' | 'cited'} Direction */

/**
 * @typedef {object} Graph
 * @property {string | null} anchorId
 * @property {Map<string, object>} works          Work objects from the API, by Tracer ID.
 * @property {Map<string, 'anchor' | Direction>} relations
 *   How each work joined the graph: the anchor, found as a citing work, or found as a cited work.
 * @property {Map<string, Set<Direction>>} expanded  Directions already fetched for each work.
 */

/** @returns {Graph} */
export function emptyGraph() {
  return { anchorId: null, works: new Map(), relations: new Map(), expanded: new Map() };
}

/**
 * Returns a new graph with `works` added. Existing works keep their relation; their data is
 * refreshed.
 *
 * @param {Graph} graph
 * @param {object[]} works
 * @param {'anchor' | Direction} relation
 */
export function addWorks(graph, works, relation) {
  const nextWorks = new Map(graph.works);
  const nextRelations = new Map(graph.relations);
  for (const work of works) {
    nextWorks.set(work.id, work);
    if (!nextRelations.has(work.id)) nextRelations.set(work.id, relation);
  }
  return { ...graph, works: nextWorks, relations: nextRelations };
}

/**
 * @param {Graph} graph
 * @param {string} id
 * @param {Direction} direction
 */
export function markExpanded(graph, id, direction) {
  const expanded = new Map(graph.expanded);
  expanded.set(id, new Set([...(expanded.get(id) ?? []), direction]));
  return { ...graph, expanded };
}

/**
 * Every citation between two works on the graph, as { source: citing, target: cited }.
 *
 * @param {Map<string, object>} works
 */
export function deriveEdges(works) {
  const edges = [];
  for (const work of works.values()) {
    for (const ref of new Set(work.references)) {
      if (ref !== work.id && works.has(ref)) edges.push({ source: work.id, target: ref });
    }
  }
  return edges;
}

/**
 * How many works on the graph cite each work. This drives node size; swap this function to
 * change the sizing metric.
 *
 * @param {Map<string, object>} works
 * @returns {Map<string, number>}
 */
export function inGraphCitationCounts(works) {
  const counts = new Map([...works.keys()].map((id) => [id, 0]));
  for (const { target } of deriveEdges(works)) counts.set(target, counts.get(target) + 1);
  return counts;
}

/**
 * @typedef {object} Filters
 * @property {number | null} minYear
 * @property {number | null} maxYear
 * @property {number} minCitations  Minimum in-graph citation count.
 */

/** @type {Filters} */
export const NO_FILTERS = { minYear: null, maxYear: null, minCitations: 0 };

/**
 * IDs of works that pass the filters. The anchor and any `alwaysShow` IDs (e.g. the selection)
 * stay visible regardless.
 *
 * @param {Graph} graph
 * @param {Filters} filters
 * @param {Map<string, number>} counts
 * @param {Iterable<string>} [alwaysShow]
 * @returns {Set<string>}
 */
export function visibleIds(graph, filters, counts, alwaysShow = []) {
  const keep = new Set([graph.anchorId, ...alwaysShow].filter(Boolean));
  const visible = new Set();
  for (const work of graph.works.values()) {
    const passes =
      (filters.minYear == null || (work.year != null && work.year >= filters.minYear)) &&
      (filters.maxYear == null || (work.year != null && work.year <= filters.maxYear)) &&
      (counts.get(work.id) ?? 0) >= filters.minCitations;
    if (passes || keep.has(work.id)) visible.add(work.id);
  }
  return visible;
}

/** Runs `task` over `items` with at most `concurrency` in flight. */
async function forEachLimited(items, concurrency, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

/**
 * @typedef {object} BuildOptions
 * @property {number} citingDepth  Levels of citing works to follow from the anchor.
 * @property {number} citedDepth   Levels of cited works to follow from the anchor.
 * @property {number} limit        Max works fetched per node per direction.
 * @property {number} maxNodes     Stop adding works once the graph has this many.
 * @property {number} [concurrency]
 */

/**
 * @typedef {object} GraphApi
 * @property {(id: string) => Promise<object>} getWork
 * @property {(id: string, opts: { limit: number }) => Promise<object[]>} getCiting
 * @property {(id: string, opts: { limit: number }) => Promise<object[]>} getCited
 */

const fetchers = { citing: 'getCiting', cited: 'getCited' };

/**
 * Builds a graph breadth-first from an anchor work. Each direction follows only its own
 * direction (citing works of citing works, cited works of cited works), to its own depth.
 * Levels alternate between directions so maxNodes doesn't starve one of them.
 *
 * @param {string} anchorId  Any ID the API accepts (Tracer ID, DOI, OpenAlex ID).
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]  Called with each intermediate graph.
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function buildGraph(anchorId, options, api, onProgress = () => {}) {
  const { citingDepth, citedDepth, limit, maxNodes, concurrency = 4 } = options;
  const anchor = await api.getWork(anchorId);
  let graph = addWorks({ ...emptyGraph(), anchorId: anchor.id }, [anchor], 'anchor');
  onProgress(graph);

  let truncated = false;
  const frontiers = { citing: [anchor.id], cited: [anchor.id] };
  const depths = { citing: citingDepth, cited: citedDepth };

  for (let level = 1; level <= Math.max(citingDepth, citedDepth); level++) {
    for (const direction of /** @type {Direction[]} */ (['citing', 'cited'])) {
      if (level > depths[direction]) continue;
      const next = [];
      await forEachLimited(frontiers[direction], concurrency, async (id) => {
        if (graph.works.size >= maxNodes) {
          truncated = true;
          return;
        }
        const found = await api[fetchers[direction]](id, { limit });
        const fresh = found.filter((work) => !graph.works.has(work.id));
        const room = maxNodes - graph.works.size;
        if (fresh.length > room) truncated = true;
        const added = fresh.slice(0, Math.max(0, room));
        graph = markExpanded(addWorks(graph, added, direction), id, direction);
        next.push(...added.map((work) => work.id));
        onProgress(graph);
      });
      frontiers[direction] = next;
    }
  }
  return { graph, truncated };
}

/**
 * Fetches a work's citing and cited works and merges them into the graph. Directions already
 * fetched for that work are skipped. Manual expansion ignores maxNodes: the user asked for it.
 *
 * @param {Graph} graph
 * @param {string} id
 * @param {{ limit: number }} options
 * @param {GraphApi} api
 * @returns {Promise<(graph: Graph) => Graph>}  An updater to apply to the latest graph.
 */
export async function expandWork(graph, id, { limit }, api) {
  const done = graph.expanded.get(id) ?? new Set();
  const directions = /** @type {Direction[]} */ (['citing', 'cited']).filter((d) => !done.has(d));
  const results = await Promise.all(
    directions.map(async (direction) => ({
      direction,
      works: await api[fetchers[direction]](id, { limit }),
    })),
  );
  return (latest) =>
    results.reduce(
      (acc, { direction, works }) => markExpanded(addWorks(acc, works, direction), id, direction),
      latest,
    );
}

/**
 * @typedef {object} LayoutYear
 * @property {number | null} year  Year used for layout; null if nothing can be inferred.
 * @property {boolean} inferred   True when the work has no publication year of its own.
 */

/**
 * The year each work is placed at in the layout.
 *
 * Works with a publication year use it. For undated works:
 * 1. Infer from dated neighbors on the graph: a work is older than any work that cites it and
 *    newer than any work it cites. With both bounds, use the midpoint; with one, place it a
 *    year beyond.
 * 2. Guarantee the anchor rule: a work the anchor cites is older than the anchor, and a work
 *    citing the anchor is newer.
 * 3. Otherwise fall back on how the work joined the graph: cited works (found by following
 *    references back from the anchor) are older, citing works newer.
 *
 * @param {Graph} graph
 * @returns {Map<string, LayoutYear>}
 */
export function layoutYears(graph) {
  const citedBy = new Map();
  const cites = new Map();
  for (const { source, target } of deriveEdges(graph.works)) {
    if (!citedBy.has(target)) citedBy.set(target, []);
    if (!cites.has(source)) cites.set(source, []);
    citedBy.get(target).push(source);
    cites.get(source).push(target);
  }
  const yearOf = (id) => graph.works.get(id)?.year ?? null;

  const fromNeighbors = (id) => {
    const citerYears = (citedBy.get(id) ?? []).map(yearOf).filter((y) => y != null);
    const citedYears = (cites.get(id) ?? []).map(yearOf).filter((y) => y != null);
    const upper = citerYears.length ? Math.min(...citerYears) : null;
    const lower = citedYears.length ? Math.max(...citedYears) : null;
    if (upper != null && lower != null) return (upper + lower) / 2;
    if (upper != null) return upper - 1;
    if (lower != null) return lower + 1;
    return null;
  };

  const anchor = graph.works.get(graph.anchorId);
  const anchorYear = anchor ? (anchor.year ?? fromNeighbors(anchor.id)) : null;
  const anchorCites = new Set(anchor?.references ?? []);

  const result = new Map();
  for (const work of graph.works.values()) {
    if (work.year != null) {
      result.set(work.id, { year: work.year, inferred: false });
      continue;
    }
    if (work.id === graph.anchorId) {
      result.set(work.id, { year: anchorYear, inferred: true });
      continue;
    }

    let year = fromNeighbors(work.id);
    if (anchorYear != null) {
      const citedByAnchor = anchorCites.has(work.id);
      const citesAnchor = work.references.includes(graph.anchorId);
      if (citedByAnchor && !citesAnchor) year = Math.min(year ?? anchorYear - 1, anchorYear - 1);
      else if (citesAnchor && !citedByAnchor)
        year = Math.max(year ?? anchorYear + 1, anchorYear + 1);
      else if (year == null) {
        const relation = graph.relations.get(work.id);
        year =
          relation === 'cited'
            ? anchorYear - 1
            : relation === 'citing'
              ? anchorYear + 1
              : anchorYear;
      }
    }
    result.set(work.id, { year, inferred: true });
  }
  return result;
}

/**
 * Positions along the time axis for a set of years, centered on 0. Distinct years are spaced
 * in order; larger gaps get logarithmically more room, so a long gap is visible without
 * squeezing densely published decades together.
 *
 * @param {Iterable<number>} years
 * @param {number} [spacing]  Distance between consecutive years.
 * @returns {Map<number, number>}
 */
export function yearPositions(years, spacing = 15) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const positions = new Map();
  let position = 0;
  sorted.forEach((year, i) => {
    if (i > 0) position += spacing * (1 + Math.log2(Math.max(1, year - sorted[i - 1])));
    positions.set(year, position);
  });
  const offset = position / 2;
  for (const [year, p] of positions) positions.set(year, p - offset);
  return positions;
}

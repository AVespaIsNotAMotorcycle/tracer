// Pure citation-graph logic, independent of React and rendering.
//
// A graph holds works keyed by Tracer ID. Edges and in-graph citation counts are derived from
// each work's `references`, never stored, because they change whenever works are added.
// Filters decide what is visible; they never remove works from the graph.

/** @typedef {'citing' | 'cited'} Direction */

/**
 * @typedef {object} Graph
 * @property {string | null} rootId
 * @property {Map<string, object>} works          Work objects from the API, by Tracer ID.
 * @property {Map<string, 'root' | Direction>} relations
 *   How each work joined the graph: the root, found as a citing work, or found as a cited work.
 * @property {Map<string, Set<Direction>>} expanded  Directions already fetched for each work.
 */

/** @returns {Graph} */
export function emptyGraph() {
  return { rootId: null, works: new Map(), relations: new Map(), expanded: new Map() };
}

/**
 * Returns a new graph with `works` added. Existing works keep their relation; their data is
 * refreshed.
 *
 * @param {Graph} graph
 * @param {object[]} works
 * @param {'root' | Direction} relation
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
 * IDs of works that pass the filters. The root and any `alwaysShow` IDs (e.g. the selection)
 * stay visible regardless.
 *
 * @param {Graph} graph
 * @param {Filters} filters
 * @param {Map<string, number>} counts
 * @param {Iterable<string>} [alwaysShow]
 * @returns {Set<string>}
 */
export function visibleIds(graph, filters, counts, alwaysShow = []) {
  const keep = new Set([graph.rootId, ...alwaysShow].filter(Boolean));
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
 * @property {number} citingDepth  Levels of citing works to follow from the root.
 * @property {number} citedDepth   Levels of cited works to follow from the root.
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
 * Builds a graph breadth-first from a root work. Each direction follows only its own
 * direction (citing works of citing works, cited works of cited works), to its own depth.
 * Levels alternate between directions so maxNodes doesn't starve one of them.
 *
 * @param {string} rootId  Any ID the API accepts (Tracer ID, DOI, OpenAlex ID).
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]  Called with each intermediate graph.
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function buildGraph(rootId, options, api, onProgress = () => {}) {
  const { citingDepth, citedDepth, limit, maxNodes, concurrency = 4 } = options;
  const root = await api.getWork(rootId);
  let graph = addWorks({ ...emptyGraph(), rootId: root.id }, [root], 'root');
  onProgress(graph);

  let truncated = false;
  const frontiers = { citing: [root.id], cited: [root.id] };
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

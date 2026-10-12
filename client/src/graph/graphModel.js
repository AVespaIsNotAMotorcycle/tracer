// Pure citation-graph logic, independent of React and rendering.
//
// A graph holds works keyed by Tracer ID. Edges and in-graph citation counts are derived from
// each work's `references`, never stored, because they change whenever works are added.
// Filters decide what is visible; they never remove works from the graph.

import { noProgress } from './progress.js';
import { REFERENCE_ONLY, sourceTypeKey } from './sourceTypeKeys.js';

/** @typedef {'citing' | 'cited'} Direction */

/**
 * @typedef {object} Graph
 * @property {string | null} anchorId
 * @property {Map<string, object>} works          Work objects from the API, by Tracer ID.
 * @property {Map<string, 'anchor' | Direction>} relations
 *   How each work joined the graph: the anchor, found as a citing work, or found as a cited work.
 * @property {Map<string, Set<Direction>>} expanded  Directions already fetched for each work.
 * @property {Set<string>} sticky
 *   Works whose neighbors stay on the graph when the anchor changes: works the user expanded,
 *   and previous anchors. (Works the build traversed on its own are not sticky; they're
 *   rebuilt relative to the new anchor.)
 */

/** @returns {Graph} */
export function emptyGraph() {
  return {
    anchorId: null,
    works: new Map(),
    relations: new Map(),
    expanded: new Map(),
    sticky: new Set(),
  };
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
 * Returns a new graph with the works found in `direction` from work `id` added (or only
 * `added`, a subset, e.g. when the graph is nearly full). Every found cited work is also added
 * to `id`'s references: a work's cited list is its reference list, and it can include works
 * its own record didn't list (e.g. reference-only works, resolved later).
 *
 * @param {Graph} graph
 * @param {string} id
 * @param {object[]} found
 * @param {Direction} direction
 * @param {object[]} [added]
 */
export function addFoundWorks(graph, id, found, direction, added = found) {
  const next = addWorks(graph, added, direction);
  const work = next.works.get(id);
  if (direction !== 'cited' || !work) return next;
  const missing = found.map((w) => w.id).filter((ref) => !work.references.includes(ref));
  if (missing.length === 0) return next;
  const nextWorks = new Map(next.works);
  nextWorks.set(id, { ...work, references: [...work.references, ...missing] });
  return { ...next, works: nextWorks };
}

/** Whether `work` has neighbors to fetch: reference-only works have none. */
export const canExpand = (work) => work?.type !== REFERENCE_ONLY;

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
 * How many works on the graph cite each work (shown in the details panel).
 *
 * @param {Map<string, object>} works
 * @returns {Map<string, number>}
 */
export function inGraphCitationCounts(works) {
  const counts = new Map([...works.keys()].map((id) => [id, 0]));
  for (const { target } of deriveEdges(works)) counts.set(target, counts.get(target) + 1);
  return counts;
}

// Separators that start a part's DOI suffix after its book's DOI: Cambridge `….005`,
// Springer `…_5`, De Gruyter `…-005`, and `/`.
const PART_SEPARATOR = /[._\-/]/;

/**
 * The view of the graph with each book's parts (chapters, front matter) folded into the book:
 * a work whose DOI is a book's DOI plus a suffix (`10.1017/9781108647403.005` is part of
 * `10.1017/9781108647403`) isn't a node of its own when that book is on the graph. Citations to
 * and from a part count as citations to and from its book. The anchor is never folded away.
 *
 * Like filters, this only changes what is shown: the graph itself keeps every part, so
 * fetching, expansion and re-anchoring are unaffected.
 *
 * @param {Graph} graph
 * @returns {{ graph: Graph, partsOf: Map<string, object[]>, bookOf: Map<string, string> }}
 *   The view graph (same shape as a Graph), each book's parts in DOI order, and each folded
 *   part's book.
 */
export function foldBookParts(graph) {
  const bookByDoi = new Map();
  for (const work of graph.works.values()) {
    const doi = work.externalIds?.doi;
    if (work.type === 'book' && doi) bookByDoi.set(doi, work.id);
  }
  const bookOf = new Map();
  if (bookByDoi.size > 0) {
    for (const work of graph.works.values()) {
      const doi = work.externalIds?.doi;
      if (!doi || work.type === 'book' || work.id === graph.anchorId) continue;
      // The longest book DOI this DOI extends, if any.
      for (let i = doi.length - 1; i > 0; i--) {
        if (!PART_SEPARATOR.test(doi[i])) continue;
        const bookId = bookByDoi.get(doi.slice(0, i));
        if (bookId) {
          bookOf.set(work.id, bookId);
          break;
        }
      }
    }
  }
  if (bookOf.size === 0) return { graph, partsOf: new Map(), bookOf };

  const partsOf = new Map();
  for (const [partId, bookId] of bookOf) {
    if (!partsOf.has(bookId)) partsOf.set(bookId, []);
    partsOf.get(bookId).push(graph.works.get(partId));
  }
  for (const parts of partsOf.values())
    parts.sort((a, b) =>
      a.externalIds.doi.localeCompare(b.externalIds.doi, undefined, { numeric: true }),
    );

  const fold = (id) => bookOf.get(id) ?? id;
  const works = new Map();
  for (const work of graph.works.values()) {
    if (bookOf.has(work.id)) continue;
    const references = [
      ...(partsOf.get(work.id) ?? []).flatMap((part) => part.references),
      ...work.references,
    ].map(fold);
    works.set(work.id, { ...work, references: [...new Set(references)] });
  }
  return { graph: { ...graph, works }, partsOf, bookOf };
}

/**
 * How many works cite each work in total, as the provider reports it (`citedByCount`), for node
 * size. A book's count includes its folded chapters' (see foldBookParts), since citations of
 * them count as the book's; works citing both are counted twice. Works with no count (e.g.
 * reference-only works) get 0. Swap this function to change the sizing metric.
 *
 * @param {Map<string, object>} works
 * @param {Map<string, object[]>} [partsOf]
 * @returns {Map<string, number>}
 */
export function totalCitationCounts(works, partsOf = new Map()) {
  const total = (work) => work.citedByCount ?? 0;
  return new Map(
    [...works.values()].map((work) => [
      work.id,
      total(work) + (partsOf.get(work.id) ?? []).reduce((sum, part) => sum + total(part), 0),
    ]),
  );
}

/**
 * How many works on the graph each work is linked to, citing it or cited by it. A work that
 * both cites and is cited by another counts it once. Drives the connections filter.
 *
 * @param {Map<string, object>} works
 * @returns {Map<string, number>}
 */
export function inGraphConnectionCounts(works) {
  const neighbors = new Map([...works.keys()].map((id) => [id, new Set()]));
  for (const { source, target } of deriveEdges(works)) {
    neighbors.get(source).add(target);
    neighbors.get(target).add(source);
  }
  return new Map([...neighbors].map(([id, set]) => [id, set.size]));
}

/**
 * @typedef {object} Filters
 * @property {number | null} minYear
 * @property {number | null} maxYear
 * @property {number} minConnections
 *   Minimum number of works on the graph that cite it or that it cites (see
 *   inGraphConnectionCounts). 1, the lowest setting, shows every work linked to another.
 * @property {string[]} excludedTypes  Source type keys to hide (see sourceTypeKeys.js). An
 *   exclusion list, so types that first appear after expanding a node are shown.
 */

/** @type {Filters} */
export const NO_FILTERS = { minYear: null, maxYear: null, minConnections: 1, excludedTypes: [] };

/**
 * IDs of works that pass the filters. The anchor and any `alwaysShow` IDs (e.g. the selection)
 * stay visible regardless.
 *
 * @param {Graph} graph
 * @param {Filters} filters
 * @param {Map<string, number>} connections  From inGraphConnectionCounts.
 * @param {Iterable<string>} [alwaysShow]
 * @returns {Set<string>}
 */
export function visibleIds(graph, filters, connections, alwaysShow = []) {
  const keep = new Set([graph.anchorId, ...alwaysShow].filter(Boolean));
  const excluded = new Set(filters.excludedTypes ?? []);
  const visible = new Set();
  for (const work of graph.works.values()) {
    const passes =
      (filters.minYear == null || (work.year != null && work.year >= filters.minYear)) &&
      (filters.maxYear == null || (work.year != null && work.year <= filters.maxYear)) &&
      (connections.get(work.id) ?? 0) >= filters.minConnections &&
      !excluded.has(sourceTypeKey(work.type));
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

const shortTitle = (work) => {
  const title = work?.title ?? 'Untitled';
  return title.length > 50 ? `${title.slice(0, 49)}…` : title;
};

/** Identifies a neighbor-list request in the progress tracker's request list. */
const requestInfo = (direction, id, work) => ({
  key: `${direction}:${id}`,
  label: `${direction === 'citing' ? 'Works citing' : 'Works cited by'} “${shortTitle(work)}”`,
});

/**
 * Builds a graph breadth-first from an anchor work. Each direction follows only its own
 * direction (citing works of citing works, cited works of cited works), to its own depth.
 * Levels alternate between directions so maxNodes doesn't starve one of them.
 *
 * @param {string} anchorId  Any ID the API accepts (Tracer ID, DOI, OpenAlex ID).
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]  Called with each intermediate graph.
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   Receives planned, completed, and projected request counts.
 * @param {object | null} [knownAnchor]  The anchor's work, if already loaded (skips the lookup).
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function buildGraph(
  anchorId,
  options,
  api,
  onProgress = () => {},
  progress = noProgress,
  knownAnchor = null,
) {
  const { citingDepth, citedDepth, limit, maxNodes, concurrency = 4 } = options;
  const directions = /** @type {Direction[]} */ (['citing', 'cited']);
  const depths = { citing: citingDepth, cited: citedDepth };

  // New works per request so far, per direction; drives projections of later levels.
  const stats = { citing: { requests: 0, added: 0 }, cited: { requests: 0, added: 0 } };
  const rate = (d) => (stats[d].requests ? stats[d].added / stats[d].requests : limit);
  const overallRate = () => {
    const requests = stats.citing.requests + stats.cited.requests;
    return requests ? (stats.citing.added + stats.cited.added) / requests : limit;
  };
  let pending = 0; // Planned requests not yet completed.

  /**
   * Reports projected requests beyond `level`, given estimated frontier sizes for level + 1,
   * and the expected final work count. Once the graph reaches maxNodes, remaining requests
   * are skipped, so projections are scaled down to fit.
   */
  const report = (level, nextSizes) => {
    let requests = 0;
    let newWorks = pending * overallRate();
    for (const d of directions) {
      let frontier = nextSizes[d];
      for (let k = level + 1; k <= depths[d]; k++) {
        requests += frontier;
        newWorks += frontier * rate(d);
        frontier *= rate(d);
      }
    }
    const room = Math.max(0, maxNodes - graph.works.size);
    if (newWorks > room) {
      requests *= newWorks > 0 ? room / newWorks : 0;
      newWorks = room;
    }
    progress.project(requests);
    progress.setWorks(graph.works.size, graph.works.size + newWorks);
  };

  let anchor = knownAnchor;
  if (!anchor) {
    progress.plan(1);
    const finish = progress.begin({ key: 'anchor', label: `Looking up ${anchorId}` });
    anchor = await api.getWork(anchorId);
    finish();
  }
  let graph = addWorks({ ...emptyGraph(), anchorId: anchor.id }, [anchor], 'anchor');
  onProgress(graph);

  let truncated = false;
  const frontiers = { citing: [anchor.id], cited: [anchor.id] };
  report(0, { citing: 1, cited: 1 });

  for (let level = 1; level <= Math.max(citingDepth, citedDepth); level++) {
    const active = directions.filter((d) => level <= depths[d]);
    const remaining = { citing: 0, cited: 0 };
    const next = { citing: [], cited: [] };
    for (const d of active) {
      remaining[d] = frontiers[d].length;
      pending += remaining[d];
      progress.plan(remaining[d]);
      progress.queue(frontiers[d].map((id) => requestInfo(d, id, graph.works.get(id))));
    }
    const estimateNext = () =>
      Object.fromEntries(directions.map((d) => [d, next[d].length + remaining[d] * rate(d)]));
    const finishRequest = (d, finish = () => progress.complete()) => {
      remaining[d]--;
      pending--;
      finish();
      report(level, estimateNext());
    };
    report(level, estimateNext());

    for (const direction of active) {
      await forEachLimited(frontiers[direction], concurrency, async (id) => {
        const request = requestInfo(direction, id, graph.works.get(id));
        if (graph.works.size >= maxNodes || !canExpand(graph.works.get(id))) {
          if (graph.works.size >= maxNodes) truncated = true;
          progress.dequeue(request.key);
          finishRequest(direction);
          return;
        }
        const finish = progress.begin(request);
        const found = await api[fetchers[direction]](id, { limit });
        const fresh = found.filter((work) => !graph.works.has(work.id));
        const room = maxNodes - graph.works.size;
        if (fresh.length > room) truncated = true;
        const added = fresh.slice(0, Math.max(0, room));
        stats[direction].requests++;
        stats[direction].added += added.length;
        graph = markExpanded(addFoundWorks(graph, id, found, direction, added), id, direction);
        next[direction].push(...added.map((work) => work.id));
        onProgress(graph);
        finishRequest(direction, finish);
      });
      frontiers[direction] = next[direction];
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
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   Gets one completed request per direction; the caller plans 2.
 * @returns {Promise<(graph: Graph) => Graph>}  An updater to apply to the latest graph.
 */
export async function expandWork(graph, id, { limit }, api, progress = noProgress) {
  const work = graph.works.get(id);
  const all = /** @type {Direction[]} */ (['citing', 'cited']);
  if (!canExpand(work)) {
    for (const d of all) progress.dequeue(requestInfo(d, id, work).key);
    progress.complete(2);
    return (latest) => latest;
  }
  const done = graph.expanded.get(id) ?? new Set();
  const directions = all.filter((d) => !done.has(d));
  // The caller plans one request per direction; directions already fetched are skipped.
  for (const d of all) if (done.has(d)) progress.dequeue(requestInfo(d, id, work).key);
  progress.complete(all.length - directions.length);
  let loaded = 0;
  const results = await Promise.all(
    directions.map(async (direction) => {
      const finish = progress.begin(requestInfo(direction, id, work));
      const works = await api[fetchers[direction]](id, { limit });
      loaded += works.length;
      progress.setWorks(loaded);
      finish();
      return { direction, works };
    }),
  );
  return (latest) => {
    const expanded = results.reduce(
      (acc, { direction, works }) =>
        markExpanded(addFoundWorks(acc, id, works, direction), id, direction),
      latest,
    );
    return { ...expanded, sticky: new Set(expanded.sticky).add(id) };
  };
}

// Works expanded at once by expandWorks; each fetches both directions in parallel.
const EXPAND_CONCURRENCY = 2;

/**
 * Expands several works together (e.g. a book and its chapters; see foldBookParts), as
 * expandWork does for one, and merges the results in a single update.
 *
 * @param {Graph} graph
 * @param {string[]} ids
 * @param {{ limit: number }} options
 * @param {GraphApi} api
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   The caller plans 2 per work.
 * @returns {Promise<(graph: Graph) => Graph>}  An updater to apply to the latest graph.
 */
export async function expandWorks(graph, ids, options, api, progress = noProgress) {
  progress.queue(
    ids.flatMap((id) => ['citing', 'cited'].map((d) => requestInfo(d, id, graph.works.get(id)))),
  );
  const updaters = [];
  await forEachLimited(ids, EXPAND_CONCURRENCY, async (id) => {
    updaters.push(await expandWork(graph, id, options, api, progress));
  });
  return (latest) => updaters.reduce((acc, apply) => apply(acc), latest);
}

/**
 * Relation for a kept work relative to a new anchor, when it wasn't reached by the new build:
 * direct citations decide it, otherwise publication order.
 */
function relationTo(anchor, work) {
  if (anchor.references.includes(work.id)) return 'cited';
  if (work.references.includes(anchor.id)) return 'citing';
  if (work.year != null && anchor.year != null)
    return work.year <= anchor.year ? 'cited' : 'citing';
  return 'cited';
}

/**
 * Rebuilds the graph around a different work already on it.
 *
 * The new anchor gets a fresh build at `options` depths, so depth is measured from it. Sticky
 * works (the previous anchor, works the user expanded, and earlier anchors) stay, along with
 * their citing and cited works, as if still expanded. Everything else the old build reached
 * is dropped unless the new build reaches it too.
 *
 * Neighbor lists are fetched again rather than tracked; the server caches them.
 *
 * @param {Graph} graph
 * @param {string} anchorId  Tracer ID of a work on `graph`.
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function reanchorGraph(
  graph,
  anchorId,
  options,
  api,
  onProgress = () => {},
  progress = noProgress,
) {
  const anchor = graph.works.get(anchorId);
  if (!anchor) throw new Error(`Work ${anchorId} is not on the graph`);
  const sticky = new Set([...graph.sticky, graph.anchorId].filter((id) => id && id !== anchorId));
  // Two requests per sticky work (citing and cited) are known up front.
  progress.plan(sticky.size * 2);
  progress.queue(
    [...sticky].flatMap((id) =>
      ['citing', 'cited'].map((d) => requestInfo(d, id, graph.works.get(id))),
    ),
  );

  // The anchor's data is already here, so the build doesn't fetch it.
  const built = await buildGraph(anchorId, options, api, onProgress, progress, anchor);

  let next = { ...built.graph, sticky };
  for (const id of sticky) {
    const work = graph.works.get(id);
    if (!next.works.has(id)) {
      const previous = graph.relations.get(id);
      next = addWorks(next, [work], previous === 'anchor' ? relationTo(anchor, work) : previous);
    }
    next = (await expandWork(next, id, { limit: options.limit }, api, progress))(next);
    progress.setWorks(next.works.size);
    onProgress(next);
  }
  return { graph: next, truncated: built.truncated };
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

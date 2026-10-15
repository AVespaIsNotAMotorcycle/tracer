// Pure citation-graph logic, independent of React and rendering.
//
// A graph holds works keyed by Tracer ID. Edges and in-graph citation counts are derived from
// each work's `references`, never stored, because they change whenever works are added.
// Filters decide what is visible; they never remove works from the graph.

import { noProgress } from './progress.js';
import { languageKey } from './languages.js';
import { REFERENCE_ONLY, sourceTypeKey } from './sourceTypeKeys.js';

/** @typedef {'citing' | 'cited'} Direction */

/**
 * @typedef {object} Graph
 * @property {string[]} anchorIds
 *   The works the graph is built around, in the order they were added. The first is the
 *   primary anchor (first in the URL, centered lane, default name).
 * @property {Map<string, object>} works          Work objects from the API, by Tracer ID.
 * @property {Map<string, 'anchor' | Direction>} relations
 *   How each work joined the graph: an anchor, found as a citing work, or found as a cited work
 *   (relative to the anchor it was first reached from).
 * @property {Map<string, Set<Direction>>} expanded  Directions already fetched for each work.
 * @property {Set<string>} sticky
 *   Works whose neighbors stay on the graph when the anchors change: works the user expanded,
 *   and previous anchors. (Works the build traversed on its own are not sticky; they're
 *   rebuilt relative to the new anchor.)
 * @property {Set<string>} [coCitationAdded]
 *   Works only on the graph because a co-citation search added them (see applyCoCitations),
 *   so a higher minimum can take them away again. Rebuilding clears it.
 * @property {Map<string, string>} [aliases]
 *   Works merged on the server into another (a duplicate record, or a reference-only work
 *   matched to a work on OpenAlex), by the ID of the work they're now part of (see
 *   foldAliases). Rebuilding clears it: the server only returns the merged works.
 */

/** @returns {Graph} */
export function emptyGraph() {
  return {
    anchorIds: [],
    works: new Map(),
    relations: new Map(),
    expanded: new Map(),
    sticky: new Set(),
    coCitationAdded: new Set(),
    aliases: new Map(),
  };
}

/** Whether `id` is one of the graph's anchors. */
export const isAnchor = (graph, id) => graph.anchorIds.includes(id);

/** Whether two lists of anchors are the same, in the same order. */
export const sameAnchors = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The graph's anchor works, in order (any not on it are skipped). */
const anchorWorks = (graph) => graph.anchorIds.map((id) => graph.works.get(id)).filter(Boolean);

/**
 * Returns a new graph with `works` added. Existing works keep their relation; their data is
 * refreshed. A work with `mergedIds` (works the server merged into it) replaces those works
 * wherever they are on the graph (see foldAliases).
 *
 * @param {Graph} graph
 * @param {object[]} works
 * @param {'anchor' | Direction} relation
 */
export function addWorks(graph, works, relation) {
  const nextWorks = new Map(graph.works);
  const nextRelations = new Map(graph.relations);
  const known = graph.aliases ?? new Map();
  const aliases = new Map();
  for (const work of works) {
    nextWorks.set(work.id, work);
    if (!nextRelations.has(work.id)) nextRelations.set(work.id, relation);
    for (const id of work.mergedIds ?? []) {
      if (id !== work.id && known.get(id) !== work.id) aliases.set(id, work.id);
    }
  }
  const next = { ...graph, works: nextWorks, relations: nextRelations };
  return aliases.size ? foldAliases(next, aliases) : next;
}

/**
 * The `referenceProviders` (see provenance.js) of `works` combined, with each reference
 * renamed by `rename`: a citation of two works that became one is from every provider of
 * either.
 *
 * @param {object[]} works
 * @param {(id: string) => string} rename
 */
function renameProviders(works, rename) {
  const combined = {};
  for (const work of works) {
    for (const [ref, providers] of Object.entries(work.referenceProviders ?? {})) {
      const key = rename(ref);
      combined[key] = [...new Set([...(combined[key] ?? []), ...providers])];
    }
  }
  return combined;
}

/**
 * Returns `graph` with each work in `aliases` (merged ID → the ID of the work it was merged
 * into, which must be on the graph) replaced by the work it's now part of: dropped from the
 * works, and renamed in references, relations, expansions, sticky works, co-citations and
 * anchors. Where both were there, an anchor relation wins, otherwise the one there first, and
 * their expanded directions combine.
 *
 * @param {Graph} graph
 * @param {Map<string, string>} aliases
 * @returns {Graph}
 */
export function foldAliases(graph, aliases) {
  const to = (id) => aliases.get(id) ?? id;
  const works = new Map();
  for (const [id, work] of graph.works) {
    if (aliases.has(id)) continue;
    if (!work.references.some((ref) => aliases.has(ref))) {
      works.set(id, work);
      continue;
    }
    works.set(id, {
      ...work,
      references: [...new Set(work.references.map(to))].filter((ref) => ref !== id),
      referenceProviders: renameProviders([work], to),
    });
  }
  const relations = new Map();
  for (const [id, relation] of graph.relations) {
    const key = to(id);
    if (!relations.has(key) || relation === 'anchor') relations.set(key, relation);
  }
  const expanded = new Map();
  for (const [id, directions] of graph.expanded) {
    const key = to(id);
    expanded.set(key, new Set([...(expanded.get(key) ?? []), ...directions]));
  }
  const rename = (ids) => new Set([...ids].map(to));
  // Earlier aliases of a work merged again point to where it went.
  const known = [...(graph.aliases ?? [])].map(([id, target]) => [id, to(target)]);
  return {
    ...graph,
    anchorIds: [...new Set(graph.anchorIds.map(to))],
    works,
    relations,
    expanded,
    sticky: rename(graph.sticky),
    coCitationAdded: rename(graph.coCitationAdded ?? []),
    aliases: new Map([...known, ...aliases]),
  };
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
 * and from a part count as citations to and from its book. Anchors are never folded away.
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
      if (!doi || work.type === 'book' || isAnchor(graph, work.id)) continue;
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
    const members = [...(partsOf.get(work.id) ?? []), work];
    const references = members.flatMap((member) => member.references).map(fold);
    works.set(work.id, {
      ...work,
      references: [...new Set(references)],
      referenceProviders: renameProviders(members, fold),
    });
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
 * @property {string[]} [excludedLanguages]  Language keys to hide (see languageKey): codes,
 *   or 'unknown'. Like types, an exclusion list.
 * @property {string[]} excludedTypes  Source type keys to hide (see sourceTypeKeys.js). An
 *   exclusion list, so types that first appear after expanding a node are shown.
 */

/** @type {Filters} */
export const NO_FILTERS = {
  minYear: null,
  maxYear: null,
  minConnections: 1,
  excludedTypes: [],
  excludedLanguages: [],
};

/**
 * IDs of works that pass the filters. The anchors and any `alwaysShow` IDs (e.g. the selection)
 * stay visible regardless.
 *
 * @param {Graph} graph
 * @param {Filters} filters
 * @param {Map<string, number>} connections  From inGraphConnectionCounts.
 * @param {Iterable<string>} [alwaysShow]
 * @param {Map<string, LayoutYear>} [years]  From layoutYears: year filters then use a corrected
 *   year where the listed one was implausible.
 * @returns {Set<string>}
 */
export function visibleIds(graph, filters, connections, alwaysShow = [], years = null) {
  const keep = new Set([...graph.anchorIds, ...alwaysShow].filter(Boolean));
  const excluded = new Set(filters.excludedTypes ?? []);
  const excludedLanguages = new Set(filters.excludedLanguages ?? []);
  const visible = new Set();
  for (const work of graph.works.values()) {
    const layout = years?.get(work.id);
    const year = layout?.listedYear != null ? layout.year : work.year;
    const passes =
      (filters.minYear == null || (year != null && year >= filters.minYear)) &&
      (filters.maxYear == null || (year != null && year <= filters.maxYear)) &&
      (connections.get(work.id) ?? 0) >= filters.minConnections &&
      !excluded.has(sourceTypeKey(work.type)) &&
      !excludedLanguages.has(languageKey(work));
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
 * Builds a graph breadth-first from one or more anchor works. Each direction follows only its
 * own direction (citing works of citing works, cited works of cited works), to its own depth.
 * Levels alternate between directions so maxNodes doesn't starve one of them. With several
 * anchors, the first level holds them all, so depth is measured from the nearest anchor and
 * maxNodes is one budget for the whole graph.
 *
 * @param {string[]} anchorIds  Any IDs the API accepts (Tracer ID, DOI, OpenAlex ID).
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]  Called with each intermediate graph.
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   Receives planned, completed, and projected request counts.
 * @param {object[]} [knownAnchors]  Anchor works already loaded, by Tracer ID (skips their
 *   lookups).
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function buildGraph(
  anchorIds,
  options,
  api,
  onProgress = () => {},
  progress = noProgress,
  knownAnchors = [],
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

  const known = new Map(knownAnchors.map((work) => [work.id, work]));
  const missing = anchorIds.filter((id) => !known.has(id));
  progress.plan(missing.length);
  const looked = await Promise.all(
    missing.map(async (id) => {
      const finish = progress.begin({ key: `anchor:${id}`, label: `Looking up ${id}` });
      const work = await api.getWork(id);
      finish();
      return [id, work];
    }),
  );
  const found = new Map(looked);
  // Two IDs (a DOI and an OpenAlex ID, say) can name one work.
  const anchors = [
    ...new Map(
      anchorIds.map((id) => known.get(id) ?? found.get(id)).map((w) => [w.id, w]),
    ).values(),
  ];
  const ids = anchors.map((work) => work.id);
  let graph = addWorks({ ...emptyGraph(), anchorIds: ids }, anchors, 'anchor');
  onProgress(graph);

  let truncated = false;
  const frontiers = { citing: [...ids], cited: [...ids] };
  report(0, { citing: ids.length, cited: ids.length });

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
    // Works this found are on the graph for their own reason now, not only as co-citations.
    const foundIds = new Set(results.flatMap(({ works }) => works.map((w) => w.id)));
    const coCitationAdded = new Set(
      [...(expanded.coCitationAdded ?? [])].filter((other) => !foundIds.has(other)),
    );
    return { ...expanded, sticky: new Set(expanded.sticky).add(id), coCitationAdded };
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

// Citing works whose reference lists are fetched at once when finding co-citations.
const CO_CITATION_CONCURRENCY = 3;
// Cited works fetched per citing work when finding co-citations: the API's maximum, so a
// small "works per node" setting doesn't hide co-citations further down a reference list.
export const CO_CITATION_LIMIT = 200;
// Fewest works on the graph citing the anchor that can make a co-citation: two works citing
// the same thing is what co-citation means.
export const MIN_CO_CITERS = 2;

/**
 * The works on the graph citing any of `targets` (the anchor, and its chapters if it's a
 * book) whose reference lists can be fetched: those whose co-citations are counted.
 *
 * @param {Graph} graph
 * @param {string[]} targets
 */
export function coCiters(graph, targets) {
  const targetSet = new Set(targets);
  return [...graph.works.values()].filter(
    (work) =>
      canExpand(work) && !targetSet.has(work.id) && work.references.some((id) => targetSet.has(id)),
  );
}

/**
 * The default minimum number of citers for a co-citation: the square root of how many there
 * are, rounded up, so it grows with the graph without becoming unreachable, but never below
 * MIN_CO_CITERS.
 */
export const defaultMinCoCiters = (citerCount) =>
  Math.max(MIN_CO_CITERS, Math.ceil(Math.sqrt(citerCount)));

/**
 * @typedef {object} CoCitations
 * @property {Map<string, object[]>} found  Each citing work's cited works, by its ID.
 * @property {Map<string, number>} counts
 *   Works cited by at least MIN_CO_CITERS of the citing works, with how many cite each.
 */

/**
 * Looks for works co-cited with the anchor: fetches the cited works of each work on the graph
 * citing it (`targets`: the anchor, and its chapters if it's a book; see coCiters), up to
 * `limit` (its reference list, as on expanding), and counts how many of them cite each work.
 * Every count of MIN_CO_CITERS or more is kept, so the minimum can change afterwards without
 * fetching again (see applyCoCitations).
 *
 * @param {Graph} graph
 * @param {string[]} targets
 * @param {{ limit: number }} options
 * @param {GraphApi} api
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   Planned here, one request per citing work.
 * @returns {Promise<CoCitations>}
 */
export async function findCoCitations(graph, targets, { limit }, api, progress = noProgress) {
  const targetSet = new Set(targets);
  const citers = coCiters(graph, targets);
  progress.plan(citers.length);
  progress.queue(citers.map((work) => requestInfo('cited', work.id, work)));

  const found = new Map();
  await forEachLimited(citers, CO_CITATION_CONCURRENCY, async (citer) => {
    const finish = progress.begin(requestInfo('cited', citer.id, citer));
    try {
      found.set(citer.id, await api.getCited(citer.id, { limit }));
    } catch {
      // One reference list failing shouldn't lose the others.
    } finally {
      finish();
    }
  });

  const counts = new Map();
  for (const cited of found.values()) {
    // Counted once per citing work, even if its list names a work twice.
    for (const id of new Set(cited.map((work) => work.id))) {
      if (!targetSet.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of counts) if (count < MIN_CO_CITERS) counts.delete(id);
  return { found, counts };
}

/**
 * Makes the graph show the co-citations cited by at least `minCiters` citing works. Works an
 * earlier call added (`graph.coCitationAdded`) that no longer qualify are removed, unless the
 * user has since expanded them (sticky) or they're in `keep` (pinned); works that qualify and
 * aren't on the graph are added as cited works, most co-cited first, up to maxNodes. Each
 * citer's references gain its cited list, so edges to the added works draw. Fetching a citer's
 * cited works here doesn't mark it expanded: only some of them are added.
 *
 * @param {Graph} graph
 * @param {CoCitations} coCitations
 * @param {{ minCiters: number, maxNodes: number, keep?: Set<string> }} options
 * @returns {Graph}
 */
export function applyCoCitations(
  graph,
  { found, counts },
  { minCiters, maxNodes, keep = new Set() },
) {
  const min = Math.max(MIN_CO_CITERS, minCiters);
  const qualifies = (id) => (counts.get(id) ?? 0) >= min;
  const previous = graph.coCitationAdded ?? new Set();
  const drop = new Set(
    [...previous].filter((id) => !qualifies(id) && !graph.sticky.has(id) && !keep.has(id)),
  );

  let next = graph;
  if (drop.size > 0) {
    const without = (map) => new Map([...map].filter(([id]) => !drop.has(id)));
    next = {
      ...graph,
      works: without(graph.works),
      relations: without(graph.relations),
      expanded: without(graph.expanded),
    };
  }

  const room = Math.max(0, maxNodes - next.works.size);
  const adding = new Set(
    [...counts]
      .filter(([id, count]) => count >= min && !next.works.has(id))
      .sort((a, b) => b[1] - a[1])
      .slice(0, room)
      .map(([id]) => id),
  );
  for (const [citerId, cited] of found) {
    next = addFoundWorks(
      next,
      citerId,
      cited,
      'cited',
      cited.filter((work) => adding.has(work.id)),
    );
  }
  const added = new Set([...previous].filter((id) => !drop.has(id) && next.works.has(id)));
  for (const id of adding) added.add(id);
  return { ...next, coCitationAdded: added };
}

/**
 * @typedef {object} PathStep  One step of a path of citations (see findPath in api.js).
 * @property {object} work
 * @property {'cites' | 'cited-by' | null} link  How the step before relates to this one: it
 *   `cites` this work, or is `cited-by` it. Null on the first step.
 */

/**
 * Adds a path's works to the graph (as citing or cited works, by how they relate to the
 * anchors) and its citations to their references, so its edges draw. The works aren't marked
 * expanded: only the path was added, not their other neighbors.
 *
 * @param {Graph} graph
 * @param {PathStep[]} path
 * @returns {Graph}
 */
export function applyPath(graph, path) {
  const anchors = anchorWorks(graph);
  let next = graph;
  for (const { work } of path) {
    if (!next.works.has(work.id)) next = addWorks(next, [work], relationTo(anchors, work));
  }
  const works = new Map(next.works);
  path.forEach(({ link }, i) => {
    if (i === 0) return;
    const [citing, cited] =
      link === 'cites'
        ? [path[i - 1].work.id, path[i].work.id]
        : [path[i].work.id, path[i - 1].work.id];
    const work = works.get(citing);
    if (work && !work.references.includes(cited)) {
      // The path search follows OpenAlex's links.
      works.set(citing, {
        ...work,
        references: [...work.references, cited],
        referenceProviders: { ...work.referenceProviders, [cited]: ['openalex'] },
      });
    }
  });
  return { ...next, works };
}

/**
 * Relation for a kept work relative to the anchors, when the build didn't reach it: a direct
 * citation of or by the first anchor that has one decides it, otherwise publication order
 * relative to the primary anchor.
 *
 * @param {object[]} anchors  The anchor works, primary first.
 * @param {object} work
 */
function relationTo(anchors, work) {
  for (const anchor of anchors) {
    if (anchor.references.includes(work.id)) return 'cited';
    if (work.references.includes(anchor.id)) return 'citing';
  }
  const primary = anchors[0];
  if (work.year != null && primary?.year != null)
    return work.year <= primary.year ? 'cited' : 'citing';
  return 'cited';
}

/**
 * Rebuilds a saved graph: a build from its anchors at its options, then the expansions the user
 * made, in the order they were made (a later expansion can depend on works an earlier one
 * brought in). An expanded work the build didn't reach is fetched first. Expanded works become
 * sticky, as they were when saved.
 *
 * @param {{ anchorIds: string[], options: BuildOptions, expanded: string[] }} saved
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function restoreGraph(saved, api, onProgress = () => {}, progress = noProgress) {
  const { anchorIds, options, expanded } = saved;
  const ids = expanded.filter((id) => !anchorIds.includes(id));
  progress.plan(ids.length * 2);
  const built = await buildGraph(anchorIds, options, api, onProgress, progress);
  const graph = await addExpandedWorks(built.graph, ids, options, api, onProgress, progress);
  return { graph, truncated: built.truncated };
}

/**
 * Adds works to the graph and expands each, in order, as if the user had: works not on it yet
 * are fetched first, colored by how they relate to the anchors. One that can't be fetched is
 * skipped. They become sticky.
 *
 * @param {Graph} graph
 * @param {string[]} ids
 * @param {{ limit: number }} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 *   Gets two completed requests per work; the caller plans them.
 * @returns {Promise<Graph>}
 */
export async function addExpandedWorks(
  graph,
  ids,
  { limit },
  api,
  onProgress = () => {},
  progress = noProgress,
) {
  const anchors = anchorWorks(graph);
  for (const id of ids) {
    if (!graph.works.has(id)) {
      let work;
      try {
        work = await api.getWork(id);
      } catch {
        // Gone from the database (or the provider): skip it rather than fail the whole graph.
        progress.complete(2);
        continue;
      }
      graph = addWorks(graph, [work], relationTo(anchors, work));
    }
    graph = (await expandWork(graph, id, { limit }, api, progress))(graph);
    progress.setWorks(graph.works.size);
    onProgress(graph);
  }
  return graph;
}

/**
 * The shape of snapshots this client writes. Bumped when works gain data that older snapshots
 * lack, so the server discards those and the graph is rebuilt (see SNAPSHOT_VERSION in the
 * server's graphService.js, which a test keeps equal). 1 (no `version`): before
 * `referenceProviders`; 2: works list where each citation came from; 3: works have their
 * language and other titles; 4: works have their topic.
 */
export const SNAPSHOT_VERSION = 4;

/**
 * A built graph as plain JSON, for the server to keep as a saved graph's snapshot (so reopening
 * it needn't fetch every work again). `graphFromSnapshot` reverses it.
 *
 * @param {Graph} graph
 * @param {boolean} truncated  Whether the build stopped at maxNodes.
 */
export function graphSnapshot(graph, truncated) {
  return {
    version: SNAPSHOT_VERSION,
    anchorIds: [...graph.anchorIds],
    works: [...graph.works.values()],
    relations: [...graph.relations],
    expanded: [...graph.expanded].map(([id, directions]) => [id, [...directions]]),
    sticky: [...graph.sticky],
    truncated,
  };
}

/**
 * @param {ReturnType<typeof graphSnapshot>} snapshot
 * @returns {{ graph: Graph, truncated: boolean }}
 */
export function graphFromSnapshot(snapshot) {
  return {
    graph: {
      // Snapshots from before multiple anchors have one `anchorId`.
      anchorIds: snapshot.anchorIds ?? [snapshot.anchorId],
      works: new Map(snapshot.works.map((work) => [work.id, work])),
      relations: new Map(snapshot.relations),
      expanded: new Map(snapshot.expanded.map(([id, directions]) => [id, new Set(directions)])),
      sticky: new Set(snapshot.sticky),
      // Co-citation searches aren't saved, so their works are ordinary ones when reopened.
      coCitationAdded: new Set(),
      aliases: new Map(),
    },
    truncated: snapshot.truncated === true,
  };
}

/**
 * Returns `graph` with `ids` no longer sticky, ready for reanchorGraph on the same anchors:
 * the rebuild then keeps their neighbors only if the build (or another sticky work) reaches
 * them. This is how a user expansion is collapsed.
 *
 * @param {Graph} graph
 * @param {string[]} ids
 */
export function collapseWorks(graph, ids) {
  const drop = new Set(ids);
  return { ...graph, sticky: new Set([...graph.sticky].filter((id) => !drop.has(id))) };
}

/**
 * Rebuilds the graph around new anchors, all works already on it: a different work, the
 * anchors plus or minus one, or the same anchors (to apply options, or after a collapse).
 *
 * The anchors get a fresh build at `options` depths, so depth is measured from them. Sticky
 * works (earlier anchors no longer anchors, and works the user expanded) stay, along with
 * their citing and cited works, as if still expanded. Everything else the old build reached
 * is dropped unless the new build reaches it too. Works in `unstick` (an anchor being
 * removed) don't become sticky, so their neighbors go too.
 *
 * Neighbor lists are fetched again rather than tracked; the server caches them.
 *
 * @param {Graph} graph
 * @param {string[]} anchorIds  Tracer IDs of works on `graph`.
 * @param {BuildOptions} options
 * @param {GraphApi} api
 * @param {(graph: Graph) => void} [onProgress]
 * @param {ReturnType<typeof import('./progress.js').createProgressTracker>} [progress]
 * @param {{ unstick?: string[] }} [extra]
 * @returns {Promise<{ graph: Graph, truncated: boolean }>}
 */
export async function reanchorGraph(
  graph,
  anchorIds,
  options,
  api,
  onProgress = () => {},
  progress = noProgress,
  { unstick = [] } = {},
) {
  const anchors = anchorIds.map((id) => {
    const work = graph.works.get(id);
    if (!work) throw new Error(`Work ${id} is not on the graph`);
    return work;
  });
  const skip = new Set([...anchorIds, ...unstick]);
  const sticky = new Set([...graph.sticky, ...graph.anchorIds].filter((id) => !skip.has(id)));
  // Two requests per sticky work (citing and cited) are known up front.
  progress.plan(sticky.size * 2);
  progress.queue(
    [...sticky].flatMap((id) =>
      ['citing', 'cited'].map((d) => requestInfo(d, id, graph.works.get(id))),
    ),
  );

  // The anchors' data is already here, so the build doesn't fetch it.
  const built = await buildGraph(anchorIds, options, api, onProgress, progress, anchors);

  let next = { ...built.graph, sticky };
  for (const id of sticky) {
    const work = graph.works.get(id);
    if (!next.works.has(id)) {
      const previous = graph.relations.get(id);
      next = addWorks(next, [work], previous === 'anchor' ? relationTo(anchors, work) : previous);
    }
    next = (await expandWork(next, id, { limit: options.limit }, api, progress))(next);
    progress.setWorks(next.works.size);
    onProgress(next);
  }
  return { graph: next, truncated: built.truncated };
}

/**
 * Which anchors each work is near, for coloring a graph with several anchors: every anchor
 * within `reach` citation steps of it (either direction), where reach is the deeper of the two
 * build depths (at least 1), so a work in two anchors' neighborhoods is shared. A work further
 * from every anchor (one an expansion brought in, say) is near the closest ones; one with no
 * path to any anchor is near none. Each anchor is near only itself. Derived from the works,
 * never stored.
 *
 * @param {Graph} graph
 * @param {{ citingDepth?: number, citedDepth?: number }} [depths]
 * @returns {Map<string, string[]>}  Anchor IDs in anchor order, by work ID.
 */
export function anchorNeighborhoods(graph, { citingDepth = 1, citedDepth = 1 } = {}) {
  const reach = Math.max(citingDepth, citedDepth, 1);
  const adjacent = new Map([...graph.works.keys()].map((id) => [id, []]));
  for (const { source, target } of deriveEdges(graph.works)) {
    adjacent.get(source).push(target);
    adjacent.get(target).push(source);
  }
  const anchors = graph.anchorIds.filter((id) => adjacent.has(id));
  const distances = anchors.map((start) => {
    const dist = new Map([[start, 0]]);
    let frontier = [start];
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        for (const other of adjacent.get(id)) {
          if (dist.has(other)) continue;
          dist.set(other, dist.get(id) + 1);
          next.push(other);
        }
      }
      frontier = next;
    }
    return dist;
  });
  const result = new Map();
  for (const id of graph.works.keys()) {
    if (anchors.includes(id)) {
      result.set(id, [id]);
      continue;
    }
    const away = distances.map((dist) => dist.get(id) ?? Infinity);
    const within = anchors.filter((_, i) => away[i] <= reach);
    const nearest = Math.min(...away);
    result.set(
      id,
      within.length
        ? within
        : nearest === Infinity
          ? []
          : anchors.filter((_, i) => away[i] === nearest),
    );
  }
  return result;
}

/**
 * @typedef {object} LayoutYear
 * @property {number | null} year  Year used for layout; null if nothing can be inferred.
 * @property {boolean} inferred   True when the work has no usable publication year of its own.
 * @property {number} [listedYear]  The provider's year, when it was set aside as implausible.
 * @property {number} [citedFrom]   Then, the year of the earliest work citing it.
 */

// A work's listed year is set aside when at least this many of its dated citers, and more
// than half of them, were published before it: a work can't be cited before it exists. Usually
// it's the year of a reprint or digitized copy (OpenAlex dates Nachod's 1897 study 2003). Two,
// not one, so a single citer with a wrong year doesn't move the work.
const MIN_EARLIER_CITERS = 2;

/**
 * The year each work is placed at in the layout.
 *
 * Works with a publication year use it, unless most of the works citing it predate it (see
 * MIN_EARLIER_CITERS): then it's placed just before its earliest citer. For undated works:
 * 1. Infer from dated neighbors on the graph: a work is older than any work that cites it and
 *    newer than any work it cites. With both bounds, use the midpoint; with one, place it a
 *    year beyond.
 * 2. Guarantee the anchor rule: a work an anchor cites is older than that anchor, and a work
 *    citing an anchor is newer.
 * 3. Otherwise fall back on how the work joined the graph: cited works (found by following
 *    references back from an anchor) are older than the primary anchor, citing works newer.
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
  const listed = (id) => graph.works.get(id)?.year ?? null;
  // Listed years that can't be right: most citers came first.
  const corrected = new Map();
  for (const work of graph.works.values()) {
    if (work.year == null) continue;
    const citerYears = (citedBy.get(work.id) ?? []).map(listed).filter((y) => y != null);
    const earlier = citerYears.filter((y) => y < work.year);
    if (earlier.length >= MIN_EARLIER_CITERS && earlier.length > citerYears.length / 2) {
      corrected.set(work.id, Math.min(...earlier));
    }
  }
  const yearOf = (id) => (corrected.has(id) ? corrected.get(id) - 1 : listed(id));

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

  const anchors = anchorWorks(graph).map((anchor) => ({
    id: anchor.id,
    year: yearOf(anchor.id) ?? fromNeighbors(anchor.id),
    cites: new Set(anchor.references),
  }));
  // For works nothing else places: the primary anchor's year, or failing that the first one's
  // that has a year.
  const fallbackYear = anchors.find((anchor) => anchor.year != null)?.year ?? null;

  const result = new Map();
  for (const work of graph.works.values()) {
    if (corrected.has(work.id)) {
      const citedFrom = corrected.get(work.id);
      result.set(work.id, {
        year: citedFrom - 1,
        inferred: true,
        listedYear: work.year,
        citedFrom,
      });
      continue;
    }
    if (work.year != null) {
      result.set(work.id, { year: work.year, inferred: false });
      continue;
    }
    const asAnchor = anchors.find((anchor) => anchor.id === work.id);
    if (asAnchor) {
      result.set(work.id, { year: asAnchor.year, inferred: true });
      continue;
    }

    let year = fromNeighbors(work.id);
    // Older than every anchor citing it, newer than every anchor it cites.
    let upper = Infinity;
    let lower = -Infinity;
    for (const anchor of anchors) {
      if (anchor.year == null) continue;
      const citedByAnchor = anchor.cites.has(work.id);
      const citesAnchor = work.references.includes(anchor.id);
      if (citedByAnchor && !citesAnchor) upper = Math.min(upper, anchor.year - 1);
      else if (citesAnchor && !citedByAnchor) lower = Math.max(lower, anchor.year + 1);
    }
    if (upper !== Infinity || lower !== -Infinity) {
      year ??= upper !== Infinity ? upper : lower;
      year = Math.max(Math.min(year, upper), lower);
    } else if (year == null && fallbackYear != null) {
      const relation = graph.relations.get(work.id);
      year =
        relation === 'cited'
          ? fallbackYear - 1
          : relation === 'citing'
            ? fallbackYear + 1
            : fallbackYear;
    }
    result.set(work.id, { year, inferred: true });
  }
  return result;
}

// Years near the anchors' get more room along the axis, where the graph is usually densest
// and readers look first: steps between consecutive years there are up to 1 + FOCUS_BOOST
// times as long, and the boost halves every FOCUS_HALF_LIFE years away from the anchor.
const FOCUS_BOOST = 2;
const FOCUS_HALF_LIFE = 4;

/**
 * Positions along the time axis for a set of years, centered on 0. Distinct years are spaced
 * in order; larger gaps get logarithmically more room, so a long gap is visible without
 * squeezing densely published decades together. With `focus` years (the anchors'), steps
 * near them are stretched (see FOCUS_BOOST), so nearby years sit further apart than distant
 * ones; a step near several gets the largest boost of any.
 *
 * @param {Iterable<number>} years
 * @param {number} [spacing]  Distance between consecutive years.
 * @param {number[]} [focus]
 * @returns {Map<number, number>}
 */
export function yearPositions(years, spacing = 15, focus = []) {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  // How far a step between two years is from a focus year: 0 if it spans it.
  const distance = (a, b, f) => (f >= a && f <= b ? 0 : Math.min(Math.abs(a - f), Math.abs(b - f)));
  const weight = (a, b) =>
    focus.length === 0
      ? 1
      : 1 +
        FOCUS_BOOST * 2 ** (-Math.min(...focus.map((f) => distance(a, b, f))) / FOCUS_HALF_LIFE);
  const positions = new Map();
  let position = 0;
  sorted.forEach((year, i) => {
    if (i > 0) {
      const previous = sorted[i - 1];
      position += spacing * (1 + Math.log2(Math.max(1, year - previous))) * weight(previous, year);
    }
    positions.set(year, position);
  });
  const offset = position / 2;
  for (const [year, p] of positions) positions.set(year, p - offset);
  return positions;
}

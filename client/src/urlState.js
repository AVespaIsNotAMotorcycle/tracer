// The graph's anchors and build options, as URL query parameters, so a graph can be shared by
// copying the URL: ?anchor=<id>&citing=1&cited=2&perNode=20&max=300. A graph with several
// anchors repeats the parameter, primary anchor first: ?anchor=<id>&anchor=<id>. A saved graph is opened
// by its ID instead (?graph=<id>), which also restores its expansions, filters and view.
//
// Anchors are written as DOIs or OpenAlex IDs rather than a Tracer ID: Tracer IDs only mean
// something within one database, so they'd break when shared across deployments or after a
// database reset. The API accepts all three. Options are written only when they differ from
// the defaults, and other query parameters (e.g. ?automation) are left alone.

export const DEFAULT_OPTIONS = { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 };

const PARAMS = {
  citingDepth: { name: 'citing', min: 0, max: 3 },
  citedDepth: { name: 'cited', min: 0, max: 3 },
  limit: { name: 'perNode', min: 1, max: 200 },
  maxNodes: { name: 'max', min: 10, max: 2000 },
};

/** The most durable ID for sharing a work: DOI, then OpenAlex ID, then the Tracer ID. */
export function shareableId(work) {
  return work.externalIds?.doi ?? work.externalIds?.openalex ?? work.id;
}

/**
 * Reads the anchors and options from a query string. Missing or invalid options fall back to
 * the defaults; blank and repeated anchors are dropped.
 *
 * @param {string} search  e.g. window.location.search
 * @returns {{ anchors: string[], options: typeof DEFAULT_OPTIONS, graph: string | null }}
 */
export function readUrlState(search) {
  const params = new URLSearchParams(search);
  const anchors = [
    ...new Set(
      params
        .getAll('anchor')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const options = { ...DEFAULT_OPTIONS };
  for (const [key, { name, min, max }] of Object.entries(PARAMS)) {
    const value = Number(params.get(name));
    if (params.has(name) && Number.isInteger(value) && value >= min && value <= max) {
      options[key] = value;
    }
  }
  return { anchors, options, graph: params.get('graph')?.trim() || null };
}

/**
 * Returns `search` updated with the anchor works and the options their graph was built with.
 *
 * @param {string} search  The current query string, whose other parameters are kept.
 * @param {object[]} anchorWorks  Primary anchor first.
 * @param {typeof DEFAULT_OPTIONS} options
 */
export function writeUrlState(search, anchorWorks, options) {
  // The anchors go where the first one was (or at the end), as `set` does with one.
  const entries = [...new URLSearchParams(search)];
  const at = entries.findIndex(([name]) => name === 'anchor');
  const others = entries.filter(([name]) => name !== 'anchor');
  const anchors = anchorWorks.map((work) => ['anchor', shareableId(work)]);
  const before =
    at === -1 ? others.length : entries.slice(0, at).filter(([n]) => n !== 'anchor').length;
  const params = new URLSearchParams([
    ...others.slice(0, before),
    ...anchors,
    ...others.slice(before),
  ]);
  // A new run is no longer the saved graph the URL named.
  params.delete('graph');
  for (const [key, { name }] of Object.entries(PARAMS)) {
    if (options[key] === DEFAULT_OPTIONS[key]) params.delete(name);
    else params.set(name, String(options[key]));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Returns `search` with a saved graph's ID, so reloading reopens the saved graph. */
export function withSavedGraph(search, id) {
  const params = new URLSearchParams(search);
  params.set('graph', id);
  return `?${params}`;
}

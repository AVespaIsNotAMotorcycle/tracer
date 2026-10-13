// The graph's anchor and build options, as URL query parameters, so a graph can be shared by
// copying the URL: ?anchor=<id>&citing=1&cited=2&perNode=20&max=300. A saved graph is opened
// by its ID instead (?graph=<id>), which also restores its expansions, filters and view.
//
// The anchor is written as a DOI or OpenAlex ID rather than a Tracer ID: Tracer IDs only mean
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
 * Reads the anchor and options from a query string. Missing or invalid options fall back to
 * the defaults.
 *
 * @param {string} search  e.g. window.location.search
 */
export function readUrlState(search) {
  const params = new URLSearchParams(search);
  const anchor = params.get('anchor')?.trim() || null;
  const options = { ...DEFAULT_OPTIONS };
  for (const [key, { name, min, max }] of Object.entries(PARAMS)) {
    const value = Number(params.get(name));
    if (params.has(name) && Number.isInteger(value) && value >= min && value <= max) {
      options[key] = value;
    }
  }
  return { anchor, options, graph: params.get('graph')?.trim() || null };
}

/**
 * Returns `search` updated with an anchor work and the options its graph was built with.
 *
 * @param {string} search  The current query string, whose other parameters are kept.
 * @param {object} anchorWork
 * @param {typeof DEFAULT_OPTIONS} options
 */
export function writeUrlState(search, anchorWork, options) {
  const params = new URLSearchParams(search);
  params.set('anchor', shareableId(anchorWork));
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

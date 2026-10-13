// Client for the server's /api/works and /api/auth routes. All IDs in responses are Tracer IDs.

const DOI_PATTERN = /^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?10\.\d{4,9}\/\S+$/i;
const OPENALEX_PATTERN = /^(?:https?:\/\/openalex\.org\/)?W\d+$/i;

/** True if the input is a DOI or OpenAlex work ID rather than a search query. */
export function looksLikeWorkId(input) {
  const value = input.trim();
  return DOI_PATTERN.test(value) || OPENALEX_PATTERN.test(value);
}

async function get(path, { signal } = {}) {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

// DOIs contain slashes, so IDs are always encoded.
const workPath = (id) => `/api/works/${encodeURIComponent(id.trim())}`;

export async function searchWorks(query, { limit = 20, signal } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return (await get(`/api/works?${params}`, { signal })).works;
}

/**
 * Works matching every field of `criteria` (any, title, author, abstract, fulltext, venueIds,
 * publisherIds, fromYear, toYear, types, language, minCitations, openAccess, sort), one page
 * at a time: { works, total }, where total counts every match.
 */
export async function advancedSearch(criteria, { limit = 25, page = 1, signal } = {}) {
  const params = new URLSearchParams({ limit: String(limit), page: String(page) });
  const lists = { venueIds: 'venue', publisherIds: 'publisher', types: 'types' };
  for (const [key, value] of Object.entries(criteria)) {
    if (value == null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(lists[key] ?? key, value.join(','));
    } else {
      params.set(key, String(value).trim());
    }
  }
  return get(`/api/works/search?${params}`, { signal });
}

/** Venues ('venue') or publishers ('publisher') named like `query`: [{ id, name, hint }]. */
export async function suggest(kind, query, { signal } = {}) {
  const params = new URLSearchParams({ q: query });
  return (await get(`/api/works/suggest/${kind}?${params}`, { signal })).suggestions;
}

export async function getWork(id, { signal } = {}) {
  return (await get(workPath(id), { signal })).work;
}

export async function getCiting(id, { limit, signal } = {}) {
  return (await get(`${workPath(id)}/citing?limit=${limit}`, { signal })).works;
}

export async function getCited(id, { limit, signal } = {}) {
  return (await get(`${workPath(id)}/cited?limit=${limit}`, { signal })).works;
}

/**
 * The shortest path of citations, either way, from work `id` to work `to`, most-cited first
 * among equally short ones: { path: [{ work, link }] | null, searched, outcome, complete }.
 * `link` says how the step before relates to each work ('cites' or 'cited-by'); `outcome` is
 * 'found', 'none' (nothing links them) or 'budget' (the search stopped at its limits), and
 * `complete` is false if a much-cited work's citing list was cut short.
 */
export async function findPath(id, to, { signal } = {}) {
  const params = new URLSearchParams({ to });
  return get(`${workPath(id)}/path?${params}`, { signal });
}

/** Copies of the work on the Internet Archive (editions of a book, usually), best first. */
export async function getArchiveItems(id, { signal } = {}) {
  return (await get(`${workPath(id)}/archive`, { signal })).items;
}

/**
 * For a work not on OpenAlex, the work Crossref's citation search matched it to
 * ({ doi, title, authors, year, venue, type, links }), or null.
 */
export async function getCitationMatch(id, { signal } = {}) {
  return (await get(`${workPath(id)}/match`, { signal })).match;
}

// Accounts. The session lives in an httpOnly cookie the browser sends with same-origin
// requests; the server requires JSON for anything that changes state.
async function post(path, body = {}) {
  return send('POST', path, body);
}

async function send(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

/** The signed-in account, or null. */
export async function getCurrentUser() {
  return (await get('/api/auth/me')).user;
}

export async function signUp(email, password) {
  return (await post('/api/auth/signup', { email, password })).user;
}

export async function logIn(email, password) {
  return (await post('/api/auth/login', { email, password })).user;
}

export async function logOut() {
  await post('/api/auth/logout');
}

// Saved graphs (the signed-in user's own). `state` is what's needed to rebuild a graph:
// { anchor: { id, ref, title }, options, filters, view: { axisAngle }, expanded }. A `snapshot`
// is the graph as built (graphSnapshot), which opening the saved graph returns for a week.
const graphPath = (id) => `/api/graphs/${encodeURIComponent(id)}`;

/** Summaries of the user's saved graphs, most recently changed first. */
export async function listGraphs() {
  return (await get('/api/graphs')).graphs;
}

export async function getSavedGraph(id) {
  return (await get(graphPath(id))).graph;
}

export async function saveGraph(name, state, snapshot) {
  return (await post('/api/graphs', { name, state, snapshot })).graph;
}

export async function updateGraph(id, name, state, snapshot) {
  return (await send('PUT', graphPath(id), { name, state, snapshot })).graph;
}

/** Stores the graph as just rebuilt from the saved state `key` identifies (its stateKey). */
export async function saveGraphSnapshot(id, key, snapshot) {
  await send('PUT', `${graphPath(id)}/snapshot`, { key, snapshot });
}

export async function renameGraph(id, name) {
  return (await send('PATCH', graphPath(id), { name })).graph;
}

export async function deleteGraph(id) {
  await send('DELETE', graphPath(id));
}

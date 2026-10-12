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

export async function getWork(id, { signal } = {}) {
  return (await get(workPath(id), { signal })).work;
}

export async function getCiting(id, { limit, signal } = {}) {
  return (await get(`${workPath(id)}/citing?limit=${limit}`, { signal })).works;
}

export async function getCited(id, { limit, signal } = {}) {
  return (await get(`${workPath(id)}/cited?limit=${limit}`, { signal })).works;
}

// Accounts. The session lives in an httpOnly cookie the browser sends with same-origin
// requests; the server requires JSON for anything that changes state.
async function post(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

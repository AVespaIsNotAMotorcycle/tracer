import { ProviderError } from './errors.js';
import { normalizeDoi } from './ids.js';
import { toOpenAlexId } from './openalex.js';

/** @typedef {import('./types.js').LinkedIds} LinkedIds */

const NAME = 'opencitations';
const DEFAULT_BASE_URL = 'https://api.opencitations.net';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parses one end of an OpenCitations link, a space-separated list of prefixed IDs such as
 * "omid:br/06301011599 openalex:W1517732418 doi:10.1080/13507486.2015.1048191".
 *
 * @param {string} value
 * @returns {LinkedIds}
 */
export function parseIds(value) {
  const ids = { doi: null, openalex: null };
  for (const token of String(value ?? '').split(/\s+/)) {
    const colon = token.indexOf(':');
    const scheme = token.slice(0, colon);
    const id = token.slice(colon + 1);
    if (scheme === 'doi') ids.doi ??= normalizeDoi(id);
    if (scheme === 'openalex') ids.openalex ??= toOpenAlexId(id);
  }
  return ids;
}

/**
 * Creates the OpenCitations adapter. OpenCitations publishes open (CC0) citation links between
 * works, from Crossref and other sources. It has no work records Tracer uses, only links, so
 * the adapter returns the IDs at the other end of each link.
 *
 * Responses for much-cited works can take several seconds, so requests time out, and at most
 * `concurrency` run at once.
 *
 * @param {object} [options]
 * @param {string} [options.accessToken]  Optional OpenCitations access token.
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]  Injected for tests.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.concurrency]
 * @param {number} [options.maxRetries]   Retries for 429 and 5xx responses.
 * @param {number} [options.retryBaseMs]  Initial backoff; doubles on each retry.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected for tests.
 */
export function createOpenCitationsProvider({
  accessToken,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
  concurrency = 2,
  maxRetries = 2,
  retryBaseMs = 1000,
  sleep = defaultSleep,
} = {}) {
  let active = 0;
  const waiting = [];
  async function limited(task) {
    if (active >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  }

  /** @returns {Promise<any[]>}  Parsed JSON; an unknown DOI gives an empty list. */
  async function request(path) {
    const url = new URL(path, baseUrl);
    const headers = { Accept: 'application/json' };
    if (accessToken) headers.authorization = accessToken;
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new ProviderError(NAME, `request to ${url.pathname} failed`, { cause: err });
      }
      if (response.ok) return response.json();
      if (response.status === 404) return [];
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : retryBaseMs * 2 ** attempt);
        continue;
      }
      throw new ProviderError(NAME, `${url.pathname} returned ${response.status}`, {
        status: response.status,
      });
    }
  }

  /** @param {'references' | 'citations'} kind */
  async function links(kind, doi) {
    const normalized = normalizeDoi(doi);
    if (!normalized) throw new ProviderError(NAME, `not a DOI: ${doi}`);
    const data = await limited(() => request(`/index/v2/${kind}/doi:${normalized}`));
    const end = kind === 'references' ? 'cited' : 'citing';
    return data.map((link) => parseIds(link[end]));
  }

  return {
    name: NAME,
    /**
     * IDs of the works a DOI cites.
     *
     * @param {string} doi
     * @returns {Promise<LinkedIds[]>}
     */
    getCitedIds: (doi) => links('references', doi),
    /**
     * IDs of the works citing a DOI.
     *
     * @param {string} doi
     * @returns {Promise<LinkedIds[]>}
     */
    getCitingIds: (doi) => links('citations', doi),
  };
}

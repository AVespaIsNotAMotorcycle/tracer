import { ProviderError } from './errors.js';
import { normalizeDoi } from './ids.js';

/** @typedef {import('./types.js').ProviderReference} ProviderReference */

const NAME = 'crossref';
const DEFAULT_BASE_URL = 'https://api.crossref.org';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Crossref years are strings, sometimes with a suffix ("1983a"). */
function parseYear(value) {
  const match = String(value ?? '').match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

/**
 * The publication year of a citation deposited only as printed text. Citations usually end
 * with it, and earlier years are often part of the title ("30 Years of War, 1961–1991"), so
 * take the last plausible one.
 */
function yearInCitation(text) {
  const years = String(text ?? '').match(/(?<!\d)(?:1[5-9]\d\d|20\d\d)(?!\d)/g);
  return years ? Number(years.at(-1)) : null;
}

/**
 * Converts one entry of a Crossref `reference` list. Publishers deposit either structured
 * fields (author surname, year, article or volume title, journal) or only the citation as
 * printed (`unstructured`), and sometimes both.
 *
 * @param {any} raw
 * @returns {ProviderReference}
 */
export function normalizeReference(raw) {
  return {
    doi: normalizeDoi(raw.DOI) ?? null,
    title: raw['article-title'] ?? raw['volume-title'] ?? raw['series-title'] ?? null,
    authors: raw.author ? [{ name: raw.author, orcid: null }] : [],
    year: parseYear(raw.year) ?? yearInCitation(raw.unstructured),
    venue: raw['journal-title'] ?? (raw['article-title'] ? (raw['volume-title'] ?? null) : null),
    unstructured: raw.unstructured?.trim() || null,
  };
}

/**
 * Creates the Crossref adapter. It only reads reference lists: Crossref is where publishers
 * deposit them, including the entries OpenAlex couldn't match to a work.
 *
 * Crossref's public pool allows one request at a time, so requests are queued. A `mailto`
 * moves them to the faster "polite" pool.
 *
 * @param {object} [options]
 * @param {string} [options.mailto]       Contact address sent with requests (polite pool).
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]  Injected for tests.
 * @param {number} [options.maxRetries]   Retries for 429 and 5xx responses.
 * @param {number} [options.retryBaseMs]  Initial backoff; doubles on each retry.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected for tests.
 */
export function createCrossrefProvider({
  mailto,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  maxRetries = 3,
  retryBaseMs = 1000,
  sleep = defaultSleep,
} = {}) {
  const userAgent = `Tracer (citation graphs)${mailto ? `; mailto:${mailto}` : ''}`;
  let queue = Promise.resolve();

  /** Runs `task` after every earlier request has finished. */
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  /** @returns {Promise<any | null>}  Parsed JSON, or null on 404. */
  async function request(path) {
    const url = new URL(path, baseUrl);
    if (mailto) url.searchParams.set('mailto', mailto);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'User-Agent': userAgent },
        });
      } catch (err) {
        throw new ProviderError(NAME, `request to ${url.pathname} failed`, { cause: err });
      }
      if (response.ok) return response.json();
      if (response.status === 404) return null;
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

  return {
    name: NAME,

    /**
     * The reference list deposited for a DOI, in deposit order. Empty when the publisher
     * deposited none; null when Crossref doesn't know the DOI.
     *
     * @param {string} doi
     * @returns {Promise<ProviderReference[] | null>}
     */
    async getReferences(doi) {
      const normalized = normalizeDoi(doi);
      if (!normalized) throw new ProviderError(NAME, `not a DOI: ${doi}`);
      const data = await enqueue(() => request(`/works/${encodeURIComponent(normalized)}`));
      if (!data) return null;
      return (data.message?.reference ?? []).map(normalizeReference);
    },
  };
}

import { ProviderError } from './errors.js';

/**
 * An item on the Internet Archive: usually a scanned book (one per edition or copy), sometimes
 * a scanned article or periodical.
 *
 * @typedef {object} ArchiveItem
 * @property {string} identifier
 * @property {string} title
 * @property {string[]} creators
 * @property {number | null} year
 * @property {'open' | 'borrow' | 'print-disabled'} access
 *   Who can read it: anyone, anyone with an account (controlled lending), or only users
 *   certified as print-disabled.
 * @property {string} url
 */

const NAME = 'internetarchive';
const DEFAULT_BASE_URL = 'https://archive.org';
const FIELDS = [
  'identifier',
  'title',
  'creator',
  'year',
  'lending___status',
  'access-restricted-item',
];
// Statuses meaning anyone with an account can borrow or browse it.
const LENDABLE = new Set(['is_lendable', 'is_borrowable', 'available_to_borrow', 'is_browsable']);

const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** @returns {ArchiveItem['access']} */
function accessOf(doc) {
  const statuses = list(doc.lending___status);
  if (statuses.includes('is_readable') || String(doc['access-restricted-item']) !== 'true') {
    return 'open';
  }
  return statuses.some((status) => LENDABLE.has(status)) ? 'borrow' : 'print-disabled';
}

/**
 * Converts one advanced-search result.
 *
 * @param {any} doc
 * @returns {ArchiveItem}
 */
export function normalizeItem(doc) {
  const year = Number.parseInt(list(doc.year)[0], 10);
  return {
    identifier: doc.identifier,
    title: list(doc.title)[0] ?? '',
    creators: list(doc.creator).map(String),
    year: Number.isFinite(year) ? year : null,
    access: accessOf(doc),
    url: `https://archive.org/details/${encodeURIComponent(doc.identifier)}`,
  };
}

/**
 * Creates the Internet Archive adapter. It searches the Archive's texts (scanned books and
 * articles) by title, through its advanced search API, which needs no key. Matching results
 * to a work is up to the caller.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]  Injected for tests.
 * @param {number} [options.timeoutMs]
 */
export function createInternetArchiveProvider({
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  return {
    name: NAME,

    /**
     * Texts whose title contains all of `words`.
     *
     * @param {string[]} words  Plain words (no search syntax).
     * @param {{ rows?: number }} [options]
     * @returns {Promise<ArchiveItem[]>}
     */
    async searchTexts(words, { rows = 50 } = {}) {
      if (words.length === 0) return [];
      const params = new URLSearchParams({
        q: `title:(${words.join(' AND ')}) AND mediatype:texts`,
        rows: String(rows),
        output: 'json',
      });
      for (const field of FIELDS) params.append('fl[]', field);
      let res;
      try {
        res = await fetchImpl(`${baseUrl}/advancedsearch.php?${params}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'Tracer (citation graphs)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new ProviderError(NAME, 'request failed', { cause });
      }
      if (!res.ok) throw new ProviderError(NAME, `HTTP ${res.status}`, { status: res.status });
      const body = await res.json().catch(() => null);
      // A failed search comes back as 200 with { error }.
      if (!body?.response) throw new ProviderError(NAME, body?.error ?? 'unexpected response');
      return (body.response.docs ?? []).filter((doc) => doc.identifier).map(normalizeItem);
    },
  };
}

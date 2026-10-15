import { ProviderError } from './errors.js';
import { normalizeDoi, normalizeLanguage } from './ids.js';

/** @typedef {import('./types.js').Provider} Provider */
/** @typedef {import('./types.js').ProviderWork} ProviderWork */

const NAME = 'openalex';
const DEFAULT_BASE_URL = 'https://api.openalex.org';
const DEFAULT_LIMIT = 100;

// OpenAlex caps per_page at 100 and the number of OR'd values in one filter at 100.
const MAX_PER_PAGE = 100;
// Neighbor lookups ask for only IDs and counts, so they use the larger pages OpenAlex allows.
const NEIGHBOR_PER_PAGE = 200;
// Most citing works one neighbor lookup collects, most-cited first: about 15 requests.
const DEFAULT_MAX_CITING = 3000;
const MAX_FILTER_VALUES = 100;

// Only request the fields normalizeWork() reads. Responses are much smaller this way.
const SELECT_FIELDS = [
  'id',
  'doi',
  'ids',
  'display_name',
  'publication_year',
  'type',
  'authorships',
  'primary_location',
  'best_oa_location',
  'abstract_inverted_index',
  'cited_by_count',
  'referenced_works',
  'language',
].join(',');

// Search results whose relevance scores are within this fraction of the top score of their run
// count as equally relevant, and are ordered most-cited first (see breakRelevanceTies).
// OpenAlex's scores are decimals that almost never tie exactly, even for identical titles.
export const RELEVANCE_TIE = 0.03;

const OPENALEX_ID_PATTERN = /^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i;

/**
 * Returns the short OpenAlex work ID ("W123") from either the short form or the full URL,
 * or null if the value isn't an OpenAlex work ID.
 *
 * @param {string | null | undefined} value
 */
export function toOpenAlexId(value) {
  const match = value?.trim().match(OPENALEX_ID_PATTERN);
  return match ? match[1].toUpperCase() : null;
}

/**
 * OpenAlex stores abstracts as { word: [positions] } for licensing reasons. Rebuild the text.
 *
 * @param {Record<string, number[]> | null | undefined} index
 */
export function reconstructAbstract(index) {
  if (!index) return null;
  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  const text = words.filter(Boolean).join(' ');
  return text || null;
}

/**
 * Search results (raw, with `relevance_score`) with near-equally relevant ones ordered by
 * citations: walking down in OpenAlex's order, each run of results whose scores are within
 * RELEVANCE_TIE of the run's first is sorted by `cited_by_count`, most first (stable). Runs are
 * measured from their first score, not from neighbor to neighbor, so a long gentle slope
 * doesn't become one run. Results without a score keep their places.
 *
 * @param {any[]} results
 * @returns {any[]}
 */
export function breakRelevanceTies(results, tie = RELEVANCE_TIE) {
  const sorted = [];
  let run = [];
  const flush = () => {
    sorted.push(...run.sort((a, b) => (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0)));
    run = [];
  };
  for (const result of results) {
    const score = result.relevance_score;
    const top = run[0]?.relevance_score;
    if (typeof score !== 'number' || (run.length && !(score >= top * (1 - tie)))) flush();
    if (typeof score !== 'number') sorted.push(result);
    else run.push(result);
  }
  flush();
  return sorted;
}

/**
 * @param {any} raw  A work object from the OpenAlex API.
 * @returns {ProviderWork}
 */
export function normalizeWork(raw) {
  const providerId = toOpenAlexId(raw.id);
  const doi = normalizeDoi(raw.doi ?? raw.ids?.doi);

  const externalIds = { openalex: providerId };
  if (doi) externalIds.doi = doi;
  if (raw.ids?.pmid)
    externalIds.pmid = raw.ids.pmid.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, '');
  if (raw.ids?.mag) externalIds.mag = String(raw.ids.mag);

  const links = [{ kind: 'provider', url: `https://openalex.org/${providerId}` }];
  if (doi) links.push({ kind: 'doi', url: `https://doi.org/${doi}` });
  const landingPage = raw.primary_location?.landing_page_url;
  if (landingPage && !links.some((link) => link.url === landingPage)) {
    links.push({ kind: 'landing_page', url: landingPage });
  }
  const pdf = raw.best_oa_location?.pdf_url ?? raw.primary_location?.pdf_url;
  if (pdf) links.push({ kind: 'pdf', url: pdf });

  return {
    provider: NAME,
    providerId,
    externalIds,
    title: raw.display_name ?? raw.title ?? null,
    authors: (raw.authorships ?? []).map((authorship) => ({
      name: authorship.author?.display_name ?? authorship.raw_author_name ?? null,
      orcid: authorship.author?.orcid?.replace(/^https?:\/\/orcid\.org\//, '') ?? null,
    })),
    year: raw.publication_year ?? null,
    type: raw.type ?? null,
    venue: raw.primary_location?.source?.display_name ?? null,
    abstract: reconstructAbstract(raw.abstract_inverted_index),
    citedByCount: raw.cited_by_count ?? null,
    referencedIds: (raw.referenced_works ?? []).map(toOpenAlexId).filter(Boolean),
    links,
    // Detected by OpenAlex from the title and abstract, not deposited.
    language: normalizeLanguage(raw.language),
  };
}

// Text fields of an advanced search and the OpenAlex filter each searches.
const TEXT_FILTERS = {
  any: 'default.search',
  title: 'title.search',
  author: 'raw_author_name.search',
  abstract: 'abstract.search',
  fulltext: 'fulltext.search',
};

const SORTS = {
  relevance: 'relevance_score:desc',
  cited: 'cited_by_count:desc',
  newest: 'publication_year:desc',
  oldest: 'publication_year:asc',
};

/**
 * The OpenAlex `filter` and `sort` for an advanced search. Commas and pipes separate filters
 * and values, so they're dropped from text. Relevance needs a text field; without one, the
 * most-cited works come first.
 *
 * @param {import('./types.js').SearchCriteria} criteria
 * @returns {{ filter: string, sort: string }}
 */
export function advancedSearchParams(criteria) {
  const filters = [];
  for (const [field, filter] of Object.entries(TEXT_FILTERS)) {
    const text = criteria[field]?.replace(/[,|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) filters.push(`${filter}:${text}`);
  }
  const hasText = filters.length > 0;
  if (criteria.venueIds?.length) {
    filters.push(`primary_location.source.id:${criteria.venueIds.join('|')}`);
  }
  if (criteria.publisherIds?.length) {
    filters.push(
      `primary_location.source.host_organization_lineage:${criteria.publisherIds.join('|')}`,
    );
  }
  const { fromYear, toYear } = criteria;
  if (fromYear != null || toYear != null) {
    filters.push(`publication_year:${fromYear ?? ''}-${toYear ?? ''}`);
  }
  if (criteria.types?.length) filters.push(`type:${criteria.types.join('|')}`);
  if (criteria.language) filters.push(`language:${criteria.language}`);
  if (criteria.minCitations) filters.push(`cited_by_count:>${criteria.minCitations - 1}`);
  if (criteria.openAccess) filters.push('open_access.is_oa:true');

  const sort = criteria.sort ?? 'relevance';
  return {
    filter: filters.join(','),
    sort: sort === 'relevance' && !hasText ? SORTS.cited : SORTS[sort],
  };
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates the OpenAlex adapter.
 *
 * Costs (credits per request, per OpenAlex's response headers): single-work lookups are free,
 * list/filter requests cost 1, and searches cost 10. The keyless daily budget is small, so
 * set an API key for real use, and prefer batched filters over many list requests.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey]       OpenAlex API key. Sent as a Bearer token.
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]  Injected for tests.
 * @param {number} [options.maxRetries]   Retries for 429 and 5xx responses.
 * @param {number} [options.retryBaseMs]  Initial backoff; doubles on each retry.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected for tests.
 * @returns {Provider}
 */
export function createOpenAlexProvider({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  maxRetries = 3,
  retryBaseMs = 500,
  sleep = defaultSleep,
} = {}) {
  /**
   * @param {string} path
   * @param {Record<string, string | number>} [params]
   * @returns {Promise<any | null>}  Parsed JSON, or null on 404.
   */
  async function request(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { headers });
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

  /**
   * Pages through a /works list query with cursor paging until `limit` works are collected.
   *
   * @param {Record<string, string>} params
   * @param {number} limit
   */
  /** Up to `limit` raw works matching `params`, following cursors across pages. */
  async function listRaw(params, limit) {
    const results = [];
    let cursor = '*';
    while (cursor && results.length < limit) {
      const data = await request('/works', {
        select: SELECT_FIELDS,
        ...params,
        per_page: Math.min(MAX_PER_PAGE, limit - results.length),
        cursor,
      });
      if (!data) break;
      results.push(...data.results);
      cursor = data.results.length > 0 ? data.meta?.next_cursor : null;
    }
    return results.slice(0, limit);
  }

  async function listWorks(params, limit) {
    return (await listRaw(params, limit)).map(normalizeWork);
  }

  /** Accepts an OpenAlex ID or a DOI and returns the path segment OpenAlex expects. */
  function toLookupKey(id) {
    const openAlexId = toOpenAlexId(id);
    if (openAlexId) return openAlexId;
    const doi = normalizeDoi(id);
    if (doi) return `doi:${doi}`;
    throw new ProviderError(NAME, `unrecognized work ID: ${id}`);
  }

  async function getWork(id) {
    const data = await request(`/works/${toLookupKey(id)}`, { select: SELECT_FIELDS });
    return data && normalizeWork(data);
  }

  async function getWorks(ids) {
    const openAlexIds = [...new Set(ids.map(toOpenAlexId).filter(Boolean))];
    const found = new Map();
    for (const batch of chunk(openAlexIds, MAX_FILTER_VALUES)) {
      const works = await listWorks({ filter: `openalex:${batch.join('|')}` }, batch.length);
      for (const work of works) found.set(work.providerId, work);
    }
    return openAlexIds.map((id) => found.get(id)).filter(Boolean);
  }

  async function getWorksByDoi(dois) {
    // `,` and `|` separate filters and values, so DOIs containing them can't be batched.
    const unique = [...new Set(dois.map(normalizeDoi))].filter((doi) => doi && !/[,|]/.test(doi));
    const works = [];
    for (const batch of chunk(unique, MAX_FILTER_VALUES)) {
      // A DOI can belong to several OpenAlex works, so ask for more than one per DOI.
      works.push(...(await listWorks({ filter: `doi:${batch.join('|')}` }, batch.length * 2)));
    }
    return works;
  }

  async function getCitingWorks(id, { limit = DEFAULT_LIMIT } = {}) {
    // `cites:` needs an OpenAlex ID, so resolve DOIs first (single lookups are free).
    let openAlexId = toOpenAlexId(id);
    if (!openAlexId) {
      const work = await getWork(id);
      if (!work) return [];
      openAlexId = work.providerId;
    }
    // Most-cited first, so a limit keeps the most influential citing works.
    return listWorks({ filter: `cites:${openAlexId}`, sort: 'cited_by_count:desc' }, limit);
  }

  async function getCitedWorks(id, { limit = DEFAULT_LIMIT } = {}) {
    const work = await getWork(id);
    if (!work) return [];
    return getWorks(work.referencedIds.slice(0, limit));
  }

  async function searchWorks(query, { limit = 25 } = {}) {
    const results = await listRaw(
      { search: query, select: `${SELECT_FIELDS},relevance_score` },
      limit,
    );
    return breakRelevanceTies(results).map(normalizeWork);
  }

  /**
   * One page of works matching every given field (see advancedSearchParams), with how many
   * match in all. Filters cost list credits, not search credits.
   */
  async function searchWorksAdvanced(criteria, { limit = 25, page = 1 } = {}) {
    const { filter, sort } = advancedSearchParams(criteria);
    const data = await request('/works', {
      filter,
      sort,
      select: SELECT_FIELDS,
      per_page: Math.min(MAX_PER_PAGE, limit),
      page,
    });
    return {
      works: (data?.results ?? []).map(normalizeWork),
      total: data?.meta?.count ?? 0,
    };
  }

  /**
   * For each of `ids`, the works it cites and the works citing it, as OpenAlex IDs, with the
   * citation counts it learns along the way. Batched: one request per 100 works for their
   * references, and pages of up to 200 citing works for 100 works at a time, most-cited
   * first, up to `maxCiting` in all (beyond that `complete` is false). Only works OpenAlex
   * links are included. IDs OpenAlex has no record for (reference lists still name some
   * deleted or merged works) come back as `missing`, and are left out of the citing lookup:
   * `cites:` with such an ID matches nearly every work.
   *
   * @param {string[]} ids  OpenAlex IDs.
   * @returns {Promise<import('../works/pathSearch.js').Neighbors>}
   */
  async function getNeighborIds(ids, { maxCiting = DEFAULT_MAX_CITING } = {}) {
    const asked = new Set(ids);
    const links = new Map(ids.map((id) => [id, []]));
    const counts = new Map();
    const select = 'id,referenced_works,cited_by_count';
    for (const batch of chunk(ids, MAX_FILTER_VALUES)) {
      const data = await request('/works', {
        filter: `openalex:${batch.join('|')}`,
        select,
        per_page: MAX_FILTER_VALUES,
      });
      for (const raw of data?.results ?? []) {
        const id = toOpenAlexId(raw.id);
        if (!links.has(id)) continue;
        counts.set(id, raw.cited_by_count ?? 0);
        for (const ref of raw.referenced_works ?? []) {
          const other = toOpenAlexId(ref);
          if (other && other !== id) links.get(id).push({ id: other, link: 'cites' });
        }
      }
    }
    const existing = ids.filter((id) => counts.has(id));
    let citing = 0;
    let complete = true;
    for (const batch of chunk(existing, MAX_FILTER_VALUES)) {
      let cursor = '*';
      while (cursor) {
        if (citing >= maxCiting) {
          complete = false;
          break;
        }
        const data = await request('/works', {
          filter: `cites:${batch.join('|')}`,
          sort: 'cited_by_count:desc',
          select,
          per_page: NEIGHBOR_PER_PAGE,
          cursor,
        });
        const results = data?.results ?? [];
        for (const raw of results) {
          const id = toOpenAlexId(raw.id);
          citing++;
          counts.set(id, raw.cited_by_count ?? 0);
          // Which of the batch it cites: it can cite several.
          for (const ref of raw.referenced_works ?? []) {
            const cited = toOpenAlexId(ref);
            if (asked.has(cited) && cited !== id) {
              links.get(cited).push({ id, link: 'cited-by' });
            }
          }
        }
        cursor = results.length > 0 ? data.meta?.next_cursor : null;
      }
    }
    return { links, counts, complete, missing: ids.filter((id) => !counts.has(id)) };
  }

  /** Citation counts for OpenAlex IDs, one request per 100. */
  async function getCitationCounts(ids) {
    const counts = new Map();
    for (const batch of chunk([...new Set(ids)], MAX_FILTER_VALUES)) {
      const data = await request('/works', {
        filter: `openalex:${batch.join('|')}`,
        select: 'id,cited_by_count',
        per_page: MAX_FILTER_VALUES,
      });
      for (const raw of data?.results ?? []) {
        counts.set(toOpenAlexId(raw.id), raw.cited_by_count ?? 0);
      }
    }
    return counts;
  }

  /**
   * Venues ('venue': journals, book series) or publishers ('publisher') whose names match
   * `query`, for picking one to search within. Autocomplete requests are free.
   *
   * @returns {Promise<import('./types.js').Suggestion[]>}
   */
  async function suggest(kind, query) {
    const entity = { venue: 'sources', publisher: 'publishers' }[kind];
    if (!entity) throw new ProviderError(NAME, `unknown suggestion kind: ${kind}`);
    const data = await request(`/autocomplete/${entity}`, { q: query });
    return (data?.results ?? []).map((result) => ({
      id: result.id.replace(/^https?:\/\/openalex\.org\//, ''),
      name: result.display_name,
      hint: result.hint ?? null,
      worksCount: result.works_count ?? null,
    }));
  }

  /**
   * How many works cite any of `ids` (one work's records), by year of publication, oldest
   * first, each citing work counted once. Covers every year, unlike a work's own
   * counts_by_year, which starts in 2012. One grouped list request (1 credit); citing works
   * without a year are left out.
   *
   * @param {string[]} ids  OpenAlex IDs, at most 100.
   * @returns {Promise<{ year: number, count: number }[]>}
   */
  async function getCitationsByYear(ids) {
    const data = await request('/works', {
      filter: `cites:${ids.slice(0, MAX_FILTER_VALUES).join('|')}`,
      group_by: 'publication_year',
    });
    return (data?.group_by ?? [])
      .map((group) => ({ year: Number(group.key), count: group.count }))
      .filter((entry) => Number.isInteger(entry.year) && entry.count > 0)
      .sort((a, b) => a.year - b.year);
  }

  return {
    name: NAME,
    getWork,
    getWorks,
    getWorksByDoi,
    getCitingWorks,
    getCitedWorks,
    searchWorks,
    searchWorksAdvanced,
    suggest,
    getNeighborIds,
    getCitationCounts,
    getCitationsByYear,
  };
}

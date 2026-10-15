import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors.js';
import {
  advancedSearchParams,
  createOpenAlexProvider,
  normalizeWork,
  reconstructAbstract,
  toOpenAlexId,
} from './openalex.js';

// Trimmed to the fields the adapter selects, in the shape the live API returns.
const rawWork = (id, overrides = {}) => ({
  id: `https://openalex.org/${id}`,
  doi: null,
  ids: { openalex: `https://openalex.org/${id}` },
  display_name: `Work ${id}`,
  publication_year: 2000,
  type: 'article',
  authorships: [],
  primary_location: null,
  best_oa_location: null,
  abstract_inverted_index: null,
  cited_by_count: 0,
  referenced_works: [],
  ...overrides,
});

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const listResponse = (works, nextCursor = null) =>
  jsonResponse({ meta: { count: works.length, next_cursor: nextCursor }, results: works });

/** Builds a provider whose fetch answers each request with the next queued response. */
function setup(...responses) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const sleep = vi.fn().mockResolvedValue();
  const provider = createOpenAlexProvider({ fetch, sleep });
  const requestedUrl = (call) => new URL(fetch.mock.calls[call][0]);
  return { provider, fetch, sleep, requestedUrl };
}

describe('toOpenAlexId', () => {
  it('accepts short IDs and full URLs', () => {
    expect(toOpenAlexId('W123')).toBe('W123');
    expect(toOpenAlexId('w123')).toBe('W123');
    expect(toOpenAlexId('https://openalex.org/W123')).toBe('W123');
  });

  it('rejects non-work IDs', () => {
    expect(toOpenAlexId('A123')).toBeNull();
    expect(toOpenAlexId('10.1234/abc')).toBeNull();
    expect(toOpenAlexId(undefined)).toBeNull();
  });
});

describe('reconstructAbstract', () => {
  it('rebuilds text from an inverted index', () => {
    expect(reconstructAbstract({ the: [0, 2], cat: [1], hat: [3] })).toBe('the cat the hat');
  });

  it('returns null when there is no abstract', () => {
    expect(reconstructAbstract(null)).toBeNull();
    expect(reconstructAbstract({})).toBeNull();
  });
});

describe('normalizeWork', () => {
  it('maps an OpenAlex work to a ProviderWork', () => {
    const work = normalizeWork(
      rawWork('W2741809807', {
        doi: 'https://doi.org/10.7717/PEERJ.4375',
        ids: {
          openalex: 'https://openalex.org/W2741809807',
          doi: 'https://doi.org/10.7717/peerj.4375',
          mag: '2741809807',
          pmid: 'https://pubmed.ncbi.nlm.nih.gov/29456894',
        },
        display_name: 'The state of OA',
        publication_year: 2018,
        authorships: [
          {
            author: {
              display_name: 'Heather Piwowar',
              orcid: 'https://orcid.org/0000-0003-1613-5981',
            },
          },
          { author: { display_name: 'Jason Priem', orcid: null } },
        ],
        primary_location: {
          landing_page_url: 'https://peerj.com/articles/4375',
          pdf_url: null,
          source: { display_name: 'PeerJ' },
        },
        best_oa_location: { pdf_url: 'https://peerj.com/articles/4375.pdf' },
        abstract_inverted_index: { Despite: [0], growing: [1] },
        cited_by_count: 1217,
        referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
        language: 'en',
      }),
    );

    expect(work).toEqual({
      provider: 'openalex',
      providerId: 'W2741809807',
      externalIds: {
        openalex: 'W2741809807',
        doi: '10.7717/peerj.4375',
        pmid: '29456894',
        mag: '2741809807',
      },
      title: 'The state of OA',
      authors: [
        { name: 'Heather Piwowar', orcid: '0000-0003-1613-5981' },
        { name: 'Jason Priem', orcid: null },
      ],
      year: 2018,
      type: 'article',
      venue: 'PeerJ',
      abstract: 'Despite growing',
      citedByCount: 1217,
      referencedIds: ['W1', 'W2'],
      links: [
        { kind: 'provider', url: 'https://openalex.org/W2741809807' },
        { kind: 'doi', url: 'https://doi.org/10.7717/peerj.4375' },
        { kind: 'landing_page', url: 'https://peerj.com/articles/4375' },
        { kind: 'pdf', url: 'https://peerj.com/articles/4375.pdf' },
      ],
      language: 'en',
    });
  });

  it('skips a landing page that duplicates the DOI link', () => {
    const work = normalizeWork(
      rawWork('W1', {
        doi: 'https://doi.org/10.1234/x',
        primary_location: { landing_page_url: 'https://doi.org/10.1234/x' },
      }),
    );
    expect(work.links.map((link) => link.kind)).toEqual(['provider', 'doi']);
  });

  it('handles sparse records', () => {
    const work = normalizeWork({ id: 'https://openalex.org/W1' });
    expect(work).toMatchObject({
      providerId: 'W1',
      externalIds: { openalex: 'W1' },
      title: null,
      authors: [],
      year: null,
      venue: null,
      abstract: null,
      referencedIds: [],
    });
  });
});

describe('createOpenAlexProvider', () => {
  describe('getWork', () => {
    it('looks up by OpenAlex ID', async () => {
      const { provider, requestedUrl } = setup(jsonResponse(rawWork('W1')));

      const work = await provider.getWork('https://openalex.org/W1');

      expect(work.providerId).toBe('W1');
      expect(requestedUrl(0).pathname).toBe('/works/W1');
      expect(requestedUrl(0).searchParams.get('select')).toContain('referenced_works');
    });

    it('looks up by DOI', async () => {
      const { provider, requestedUrl } = setup(jsonResponse(rawWork('W1')));

      await provider.getWork('https://doi.org/10.1234/ABC');

      expect(requestedUrl(0).pathname).toBe('/works/doi:10.1234/abc');
    });

    it('returns null when the work does not exist', async () => {
      const { provider } = setup(jsonResponse({ error: 'not found' }, { status: 404 }));

      expect(await provider.getWork('W1')).toBeNull();
    });

    it('rejects unrecognized IDs without making a request', async () => {
      const { provider, fetch } = setup();

      await expect(provider.getWork('nonsense')).rejects.toThrow(ProviderError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('getWorks', () => {
    it('batches IDs into one filter and preserves input order', async () => {
      const { provider, fetch, requestedUrl } = setup(listResponse([rawWork('W2'), rawWork('W1')]));

      const works = await provider.getWorks(['W1', 'W2', 'W1', 'W404']);

      expect(works.map((work) => work.providerId)).toEqual(['W1', 'W2']);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(requestedUrl(0).searchParams.get('filter')).toBe('openalex:W1|W2|W404');
    });

    it('looks up DOIs in batches, skipping ones that would break the filter', async () => {
      const { provider, requestedUrl } = setup(listResponse([rawWork('W2')]));

      await provider.getWorksByDoi(['10.1234/A', 'https://doi.org/10.1234/b', '10.1234/a,b']);

      expect(requestedUrl(0).searchParams.get('filter')).toBe('doi:10.1234/a|10.1234/b');
    });

    it('splits more than 100 IDs across requests', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `W${i + 1}`);
      const { provider, fetch, requestedUrl } = setup(
        listResponse(ids.slice(0, 100).map((id) => rawWork(id))),
        listResponse(ids.slice(100).map((id) => rawWork(id))),
      );

      const works = await provider.getWorks(ids);

      expect(works).toHaveLength(150);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requestedUrl(1).searchParams.get('filter').split('|')).toHaveLength(50);
    });

    it('makes no request for an empty list', async () => {
      const { provider, fetch } = setup();

      expect(await provider.getWorks([])).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('getCitingWorks', () => {
    it('filters by cites, most-cited first', async () => {
      const { provider, requestedUrl } = setup(listResponse([rawWork('W2'), rawWork('W3')]));

      const works = await provider.getCitingWorks('W1');

      expect(works.map((work) => work.providerId)).toEqual(['W2', 'W3']);
      expect(requestedUrl(0).searchParams.get('filter')).toBe('cites:W1');
      expect(requestedUrl(0).searchParams.get('sort')).toBe('cited_by_count:desc');
    });

    it('follows cursors until the limit is reached', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => rawWork(`W${i + 10}`));
      const page2 = Array.from({ length: 20 }, (_, i) => rawWork(`W${i + 200}`));
      const { provider, fetch, requestedUrl } = setup(
        listResponse(page1, 'next'),
        listResponse(page2, 'after-next'),
      );

      const works = await provider.getCitingWorks('W1', { limit: 120 });

      expect(works).toHaveLength(120);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(requestedUrl(1).searchParams.get('cursor')).toBe('next');
      expect(requestedUrl(1).searchParams.get('per_page')).toBe('20');
    });

    it('stops when results run out before the limit', async () => {
      const { provider, fetch } = setup(listResponse([rawWork('W2')], null));

      expect(await provider.getCitingWorks('W1', { limit: 500 })).toHaveLength(1);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('resolves a DOI to an OpenAlex ID first', async () => {
      const { provider, requestedUrl } = setup(
        jsonResponse(rawWork('W1')),
        listResponse([rawWork('W2')]),
      );

      await provider.getCitingWorks('10.1234/abc');

      expect(requestedUrl(0).pathname).toBe('/works/doi:10.1234/abc');
      expect(requestedUrl(1).searchParams.get('filter')).toBe('cites:W1');
    });
  });

  describe('getCitedWorks', () => {
    it('fetches the work, then batch-fetches its references up to the limit', async () => {
      const { provider, requestedUrl } = setup(
        jsonResponse(
          rawWork('W1', {
            referenced_works: [
              'https://openalex.org/W2',
              'https://openalex.org/W3',
              'https://openalex.org/W4',
            ],
          }),
        ),
        listResponse([rawWork('W2'), rawWork('W3')]),
      );

      const works = await provider.getCitedWorks('W1', { limit: 2 });

      expect(works.map((work) => work.providerId)).toEqual(['W2', 'W3']);
      expect(requestedUrl(1).searchParams.get('filter')).toBe('openalex:W2|W3');
    });

    it('returns an empty list for an unknown work', async () => {
      const { provider } = setup(jsonResponse({}, { status: 404 }));

      expect(await provider.getCitedWorks('W1')).toEqual([]);
    });
  });

  describe('searchWorks', () => {
    it('passes the query through', async () => {
      const { provider, requestedUrl } = setup(listResponse([rawWork('W1')]));

      await provider.searchWorks('french revolution', { limit: 5 });

      expect(requestedUrl(0).searchParams.get('search')).toBe('french revolution');
      expect(requestedUrl(0).searchParams.get('per_page')).toBe('5');
    });
  });

  describe('searchWorksAdvanced', () => {
    it('requests one page of the filter, with the total', async () => {
      const { provider, requestedUrl } = setup(
        jsonResponse({ meta: { count: 1234 }, results: [rawWork('W1'), rawWork('W2')] }),
      );

      const result = await provider.searchWorksAdvanced(
        { title: 'moral economy', sort: 'cited' },
        { limit: 2, page: 3 },
      );

      expect(result.total).toBe(1234);
      expect(result.works.map((w) => w.providerId)).toEqual(['W1', 'W2']);
      const url = requestedUrl(0);
      expect(url.searchParams.get('filter')).toBe('title.search:moral economy');
      expect(url.searchParams.get('sort')).toBe('cited_by_count:desc');
      expect(url.searchParams.get('per_page')).toBe('2');
      expect(url.searchParams.get('page')).toBe('3');
    });
  });

  describe('getNeighborIds', () => {
    it('batches references and citing works, noting which work each citing one cites', async () => {
      const { provider, requestedUrl } = setup(
        jsonResponse({
          results: [
            {
              id: 'https://openalex.org/W1',
              referenced_works: ['https://openalex.org/W9'],
              cited_by_count: 4,
            },
            { id: 'https://openalex.org/W2', referenced_works: [], cited_by_count: 1 },
          ],
        }),
        jsonResponse({
          meta: { next_cursor: null },
          results: [
            {
              id: 'https://openalex.org/W7',
              referenced_works: [
                'https://openalex.org/W1',
                'https://openalex.org/W2',
                'https://openalex.org/W5',
              ],
              cited_by_count: 30,
            },
          ],
        }),
      );

      const { links, counts, complete } = await provider.getNeighborIds(['W1', 'W2']);

      expect(links.get('W1')).toEqual([
        { id: 'W9', link: 'cites' },
        { id: 'W7', link: 'cited-by' },
      ]);
      expect(links.get('W2')).toEqual([{ id: 'W7', link: 'cited-by' }]);
      expect(counts).toEqual(
        new Map([
          ['W1', 4],
          ['W2', 1],
          ['W7', 30],
        ]),
      );
      expect(complete).toBe(true);
      expect(requestedUrl(0).searchParams.get('filter')).toBe('openalex:W1|W2');
      expect(requestedUrl(1).searchParams.get('filter')).toBe('cites:W1|W2');
      expect(requestedUrl(1).searchParams.get('per_page')).toBe('200');
    });

    it('reports works with no record, leaving them out of the citing lookup', async () => {
      // `cites:` with an ID OpenAlex doesn't have matches nearly every work.
      const { provider, requestedUrl } = setup(
        jsonResponse({ results: [{ id: 'https://openalex.org/W1', referenced_works: [] }] }),
        jsonResponse({ meta: { next_cursor: null }, results: [] }),
      );
      const { missing } = await provider.getNeighborIds(['W1', 'W404']);
      expect(missing).toEqual(['W404']);
      expect(requestedUrl(1).searchParams.get('filter')).toBe('cites:W1');
    });

    it('stops collecting citing works at maxCiting', async () => {
      const citing = (n) => ({
        id: `https://openalex.org/W${n}`,
        referenced_works: ['https://openalex.org/W1'],
        cited_by_count: 0,
      });
      const { provider, fetch } = setup(
        jsonResponse({ results: [{ id: 'https://openalex.org/W1', referenced_works: [] }] }),
        jsonResponse({ meta: { next_cursor: 'next' }, results: [citing(2), citing(3)] }),
      );
      const { links, complete } = await provider.getNeighborIds(['W1'], { maxCiting: 2 });
      expect(links.get('W1')).toHaveLength(2);
      expect(complete).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('suggest', () => {
    it('autocompletes venues as short IDs', async () => {
      const { provider, requestedUrl } = setup(
        jsonResponse({
          results: [
            {
              id: 'https://openalex.org/S42922845',
              display_name: 'Past & Present',
              hint: 'Oxford University Press',
              works_count: 2616,
            },
          ],
        }),
      );

      expect(await provider.suggest('venue', 'past and present')).toEqual([
        {
          id: 'S42922845',
          name: 'Past & Present',
          hint: 'Oxford University Press',
          worksCount: 2616,
        },
      ]);
      expect(requestedUrl(0).pathname).toBe('/autocomplete/sources');
      expect(requestedUrl(0).searchParams.get('q')).toBe('past and present');
    });

    it('autocompletes publishers', async () => {
      const { provider, requestedUrl } = setup(jsonResponse({ results: [] }));
      await provider.suggest('publisher', 'cambridge');
      expect(requestedUrl(0).pathname).toBe('/autocomplete/publishers');
    });
  });

  describe('requests', () => {
    it('sends the API key as a Bearer token', async () => {
      const fetch = vi.fn().mockResolvedValue(jsonResponse(rawWork('W1')));
      const provider = createOpenAlexProvider({ fetch, apiKey: 'secret' });

      await provider.getWork('W1');

      expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    });

    it('omits Authorization without an API key', async () => {
      const { provider, fetch } = setup(jsonResponse(rawWork('W1')));

      await provider.getWork('W1');

      expect(fetch.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('retries 429 and 5xx with exponential backoff', async () => {
      const { provider, fetch, sleep } = setup(
        jsonResponse({}, { status: 429 }),
        jsonResponse({}, { status: 503 }),
        jsonResponse(rawWork('W1')),
      );

      const work = await provider.getWork('W1');

      expect(work.providerId).toBe('W1');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[500], [1000]]);
    });

    it('honors Retry-After', async () => {
      const { provider, sleep } = setup(
        jsonResponse({}, { status: 429, headers: { 'retry-after': '7' } }),
        jsonResponse(rawWork('W1')),
      );

      await provider.getWork('W1');

      expect(sleep).toHaveBeenCalledWith(7000);
    });

    it('gives up after maxRetries', async () => {
      const fetch = vi.fn().mockImplementation(async () => jsonResponse({}, { status: 429 }));
      const provider = createOpenAlexProvider({ fetch, sleep: async () => {}, maxRetries: 2 });

      await expect(provider.getWork('W1')).rejects.toMatchObject({
        name: 'ProviderError',
        status: 429,
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry other client errors', async () => {
      const { provider, fetch } = setup(jsonResponse({}, { status: 400 }));

      await expect(provider.getWork('W1')).rejects.toMatchObject({ status: 400 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('wraps network failures in ProviderError', async () => {
      const fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const provider = createOpenAlexProvider({ fetch });

      await expect(provider.getWork('W1')).rejects.toThrow(ProviderError);
    });
  });
});

describe('advancedSearchParams', () => {
  it('combines every field into one filter', () => {
    const { filter, sort } = advancedSearchParams({
      any: 'qing',
      title: 'manchus',
      author: 'Rhoads',
      abstract: 'banner',
      fulltext: 'eight banners',
      venueIds: ['S1', 'S2'],
      publisherIds: ['P3'],
      fromYear: 1990,
      toYear: 2010,
      types: ['book', 'book-chapter'],
      language: 'en',
      minCitations: 10,
      openAccess: true,
    });

    expect(filter.split(',')).toEqual([
      'default.search:qing',
      'title.search:manchus',
      'raw_author_name.search:Rhoads',
      'abstract.search:banner',
      'fulltext.search:eight banners',
      'primary_location.source.id:S1|S2',
      'primary_location.source.host_organization_lineage:P3',
      'publication_year:1990-2010',
      'type:book|book-chapter',
      'language:en',
      'cited_by_count:>9',
      'open_access.is_oa:true',
    ]);
    expect(sort).toBe('relevance_score:desc');
  });

  it('drops commas and pipes from text, which would split the filter', () => {
    expect(advancedSearchParams({ title: 'Manchus, Han | Qing' }).filter).toBe(
      'title.search:Manchus Han Qing',
    );
  });

  it('leaves either end of a year range open', () => {
    expect(advancedSearchParams({ fromYear: 1900 }).filter).toBe('publication_year:1900-');
    expect(advancedSearchParams({ toYear: 1900 }).filter).toBe('publication_year:-1900');
  });

  it('sorts by citations when there is no text to rank by relevance', () => {
    expect(advancedSearchParams({ types: ['book'] }).sort).toBe('cited_by_count:desc');
    expect(advancedSearchParams({ title: ',', types: ['book'] }).sort).toBe('cited_by_count:desc');
    expect(advancedSearchParams({ types: ['book'], sort: 'oldest' }).sort).toBe(
      'publication_year:asc',
    );
  });
});

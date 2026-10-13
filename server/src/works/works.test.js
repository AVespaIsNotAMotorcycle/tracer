import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { CacheEntry } from '../models/CacheEntry.js';
import { Source } from '../models/Source.js';
import { ProviderError } from '../providers/errors.js';
import { normalizeDoi } from '../providers/ids.js';
import { citationKey, createWorkService, DEFAULT_TTLS, REFERENCE_ONLY } from './workService.js';

/** @returns {import('../providers/types.js').ProviderWork} */
const providerWork = (id, { doi, referencedIds = [], citedByCount = 0 } = {}) => ({
  provider: 'openalex',
  providerId: id,
  externalIds: doi ? { openalex: id, doi } : { openalex: id },
  title: `Work ${id}`,
  authors: [{ name: 'A. Historian', orcid: null }],
  year: 1971,
  type: 'article',
  venue: 'Past & Present',
  abstract: null,
  citedByCount,
  referencedIds,
  links: [{ kind: 'provider', url: `https://openalex.org/${id}` }],
});

// W1 cites W2 and W3. W4 and W5 cite W1. W5 also cites W4, so W4 and W5 are neighbors.
// W3 is referenced but missing from the provider, as with real coverage gaps.
const catalog = new Map(
  [
    providerWork('W1', { doi: '10.1234/root', referencedIds: ['W2', 'W3'] }),
    providerWork('W2'),
    providerWork('W4', { referencedIds: ['W1'], citedByCount: 5 }),
    providerWork('W5', { referencedIds: ['W1', 'W4'], citedByCount: 9 }),
  ].map((work) => [work.providerId, work]),
);

/** A fake provider over `catalog`, with call counting. */
function fakeProvider() {
  // Like the real adapter, getWork accepts an OpenAlex ID or a DOI in any common form.
  const byIdOrDoi = (id) =>
    catalog.get(id) ??
    [...catalog.values()].find((w) => w.externalIds.doi === normalizeDoi(id)) ??
    null;
  return {
    name: 'openalex',
    getWork: vi.fn(async (id) => byIdOrDoi(id)),
    getWorks: vi.fn(async (ids) => ids.map((id) => catalog.get(id)).filter(Boolean)),
    getCitingWorks: vi.fn(async (id, { limit }) =>
      [...catalog.values()]
        .filter((w) => w.referencedIds.includes(id))
        .sort((a, b) => b.citedByCount - a.citedByCount)
        .slice(0, limit),
    ),
    getCitedWorks: vi.fn(),
    searchWorks: vi.fn(async (query, { limit }) => [...catalog.values()].slice(0, limit)),
  };
}

let mongo;
let provider;
let clock;
let api;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Source.init(), CacheEntry.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all([Source.deleteMany({}), CacheEntry.deleteMany({})]);
  provider = fakeProvider();
  clock = new Date('2026-01-01T00:00:00Z');
  const app = createApp({ workService: createWorkService({ provider, now: () => clock }) });
  api = request(app);
});

const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};

const tracerIdOf = async (providerId) =>
  String((await Source.findOne({ 'externalIds.openalex': providerId }).lean())._id);

describe('GET /api/works/:id', () => {
  it('returns the work with a Tracer ID and Tracer-ID references', async () => {
    const res = await api.get('/api/works/W1');

    expect(res.status).toBe(200);
    expect(res.body.work).toMatchObject({
      id: await tracerIdOf('W1'),
      externalIds: { openalex: 'W1', doi: '10.1234/root' },
      title: 'Work W1',
      providers: ['openalex'],
    });
    // W2 and W3 get stub Sources, so both references already have Tracer IDs.
    expect(res.body.work.references).toEqual([await tracerIdOf('W2'), await tracerIdOf('W3')]);
  });

  it('accepts a URL-encoded DOI, a Tracer ID, and an OpenAlex URL for the same work', async () => {
    const byDoi = await api.get(`/api/works/${encodeURIComponent('https://doi.org/10.1234/ROOT')}`);
    const id = byDoi.body.work.id;

    const byTracerId = await api.get(`/api/works/${id}`);
    const byUrl = await api.get(`/api/works/${encodeURIComponent('https://openalex.org/W1')}`);

    expect(byTracerId.body.work.id).toBe(id);
    expect(byUrl.body.work.id).toBe(id);
  });

  it('serves repeat requests from the database', async () => {
    await api.get('/api/works/W1');
    await api.get('/api/works/W1');

    expect(provider.getWork).toHaveBeenCalledTimes(1);
  });

  it('refetches after the work TTL', async () => {
    await api.get('/api/works/W1');
    advance(DEFAULT_TTLS.work + 1);
    await api.get('/api/works/W1');

    expect(provider.getWork).toHaveBeenCalledTimes(2);
  });

  it('keeps the Tracer ID stable when a stub is filled in', async () => {
    const root = await api.get('/api/works/W1');
    const stubId = root.body.work.references[0];

    const res = await api.get(`/api/works/${stubId}`);

    expect(res.status).toBe(200);
    expect(res.body.work).toMatchObject({ id: stubId, externalIds: { openalex: 'W2' } });
  });

  it('returns 404 for unknown works', async () => {
    expect((await api.get('/api/works/W999')).status).toBe(404);
    expect((await api.get('/api/works/0123456789abcdef01234567')).status).toBe(404);
  });

  it('returns 404 for a stub the provider does not have', async () => {
    const root = await api.get('/api/works/W1');
    const missingId = root.body.work.references[1]; // W3

    expect((await api.get(`/api/works/${missingId}`)).status).toBe(404);
  });

  it('returns 400 for unrecognized IDs', async () => {
    const res = await api.get('/api/works/not-an-id');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unrecognized/);
  });

  it('serves stale data when a refresh finds nothing', async () => {
    await api.get('/api/works/W1');
    advance(DEFAULT_TTLS.work + 1);
    provider.getWork.mockResolvedValueOnce(null);

    expect((await api.get('/api/works/W1')).status).toBe(200);
  });
});

describe('GET /api/works/:id/citing', () => {
  it('returns citing works, most-cited first, with neighbor edges', async () => {
    const res = await api.get('/api/works/W1/citing');

    expect(res.status).toBe(200);
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W5', 'W4']);
    const [w5, w4] = res.body.works;
    expect(w5.references).toContain(w4.id);
    expect(provider.getCitingWorks).toHaveBeenCalledWith('W1', { limit: 50 });
  });

  it('caches the list', async () => {
    await api.get('/api/works/W1/citing');
    const res = await api.get('/api/works/W1/citing');

    expect(res.body.works).toHaveLength(2);
    expect(provider.getCitingWorks).toHaveBeenCalledTimes(1);
    expect(provider.getWorks).not.toHaveBeenCalled();
  });

  it('refetches after the citing TTL', async () => {
    await api.get('/api/works/W1/citing');
    advance(DEFAULT_TTLS.citing + 1);
    await api.get('/api/works/W1/citing');

    expect(provider.getCitingWorks).toHaveBeenCalledTimes(2);
  });

  it('caches different limits separately', async () => {
    const res = await api.get('/api/works/W1/citing?limit=1');
    await api.get('/api/works/W1/citing?limit=2');

    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W5']);
    expect(provider.getCitingWorks).toHaveBeenCalledTimes(2);
  });

  it('works from a Tracer ID without fetching the root work', async () => {
    const root = await api.get('/api/works/W5');
    const w1Id = root.body.work.references[0]; // stub for W1
    provider.getWork.mockClear();

    const res = await api.get(`/api/works/${w1Id}/citing`);

    expect(res.body.works).toHaveLength(2);
    expect(provider.getWork).not.toHaveBeenCalled();
  });

  it('resolves a DOI it has not seen', async () => {
    const res = await api.get(`/api/works/${encodeURIComponent('10.1234/root')}/citing`);

    expect(res.status).toBe(200);
    expect(provider.getCitingWorks).toHaveBeenCalledWith('W1', { limit: 50 });
  });
});

describe('GET /api/works/:id/cited', () => {
  it('returns referenced works the provider has, in reference order', async () => {
    const res = await api.get('/api/works/W1/cited');

    expect(res.status).toBe(200);
    // W3 is a coverage gap, so only W2 comes back.
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W2']);
    expect(provider.getWorks).toHaveBeenCalledWith(['W2', 'W3']);
  });

  it('only fetches references that have no fresh data', async () => {
    await api.get('/api/works/W2');
    provider.getWorks.mockClear();

    await api.get('/api/works/W1/cited');

    expect(provider.getWorks).toHaveBeenCalledWith(['W3']);
  });

  it('applies the limit to the reference list', async () => {
    await api.get('/api/works/W1/cited?limit=1');

    expect(provider.getWorks).toHaveBeenCalledWith(['W2']);
  });
});

describe('cited works from deposited reference lists', () => {
  // W1's publisher deposited its reference list with Crossref. OpenAlex matched W2 and W3,
  // missed W6 (which it has, by DOI), and has nothing for the rest.
  const linked = providerWork('W6', { doi: '10.1234/linked' });
  const deccani = { title: 'Deccani Painting', authors: [{ name: 'Zebrowski' }], year: 1983 };
  const deposited = {
    '10.1234/root': [
      { doi: '10.1234/linked' },
      { ...deccani },
      // The same book, formatted differently.
      { title: 'Deccani painting.', authors: [{ name: 'ZEBROWSKI' }], year: 1983 },
      { unstructured: 'Africa Watch. Evil Days. New York, 1991.' },
      { doi: '10.9999/gone', title: 'Gone' },
      {}, // Nothing to identify it by.
    ],
  };
  const reference = (fields) => ({
    doi: null,
    title: null,
    authors: [],
    year: null,
    venue: null,
    unstructured: null,
    ...fields,
  });
  let referenceProvider;

  beforeEach(() => {
    provider.getWorksByDoi = vi.fn(async (dois) =>
      [linked].filter((w) => dois.includes(w.externalIds.doi)),
    );
    const getWorks = provider.getWorks.getMockImplementation();
    provider.getWorks = vi.fn(async (ids) => [
      ...(await getWorks(ids)),
      ...(ids.includes('W6') ? [linked] : []),
    ]);
    referenceProvider = {
      name: 'crossref',
      getReferences: vi.fn(async (doi) => (deposited[doi] ?? []).map(reference)),
    };
    const workService = createWorkService({ provider, referenceProvider, now: () => clock });
    api = request(createApp({ workService }));
  });

  it('adds works found by DOI, then reference-only works', async () => {
    const res = await api.get('/api/works/W1/cited');

    expect(res.status).toBe(200);
    expect(res.body.works.map((w) => [w.type, w.title])).toEqual([
      ['article', 'Work W2'],
      ['article', 'Work W6'],
      [REFERENCE_ONLY, 'Deccani Painting'],
      [REFERENCE_ONLY, 'Africa Watch. Evil Days. New York, 1991.'],
      [REFERENCE_ONLY, 'Gone'],
    ]);
    const [, , painting, , gone] = res.body.works;
    expect(painting).toMatchObject({
      authors: [{ name: 'Zebrowski' }],
      year: 1983,
      references: [],
      providers: ['crossref'],
    });
    expect(painting.externalIds).toEqual({});
    expect(gone.links).toEqual([{ kind: 'doi', url: 'https://doi.org/10.9999/gone' }]);
    expect(referenceProvider.getReferences).toHaveBeenCalledWith('10.1234/root');
  });

  it('includes them in the citing work’s references', async () => {
    const cited = (await api.get('/api/works/W1/cited')).body.works;
    const { work } = (await api.get('/api/works/W1')).body;

    expect(work.providers).toEqual(['openalex', 'crossref']);
    for (const { id } of cited) expect(work.references).toContain(id);
  });

  it('shares one reference-only work between reference lists', async () => {
    deposited['10.1234/other'] = [{ ...deccani }];
    catalog.set('W7', providerWork('W7', { doi: '10.1234/other' }));
    try {
      const fromW1 = (await api.get('/api/works/W1/cited')).body.works;
      const fromW7 = (await api.get('/api/works/W7/cited')).body.works;
      expect(fromW7.map((w) => w.id)).toEqual([fromW1[2].id]);
    } finally {
      catalog.delete('W7');
      delete deposited['10.1234/other'];
    }
  });

  it('caches the reference list until its TTL', async () => {
    await api.get('/api/works/W1/cited');
    await api.get('/api/works/W1/cited');
    expect(referenceProvider.getReferences).toHaveBeenCalledTimes(1);
    expect(provider.getWorksByDoi).toHaveBeenCalledTimes(1);

    advance(DEFAULT_TTLS.references + 1);
    await api.get('/api/works/W1/cited');
    expect(referenceProvider.getReferences).toHaveBeenCalledTimes(2);
  });

  it('gives reference-only works their own limit', async () => {
    const res = await api.get('/api/works/W1/cited?limit=1');
    expect(res.body.works.map((w) => w.title)).toEqual(['Work W2', 'Deccani Painting']);
  });

  it('serves a reference-only work, with nothing to fetch around it', async () => {
    const [, , painting] = (await api.get('/api/works/W1/cited')).body.works;

    const res = await api.get(`/api/works/${painting.id}`);
    expect(res.body.work).toMatchObject({ id: painting.id, type: REFERENCE_ONLY });
    expect((await api.get(`/api/works/${painting.id}/citing`)).body.works).toEqual([]);
    expect((await api.get(`/api/works/${painting.id}/cited`)).body.works).toEqual([]);
  });

  it('still returns the provider’s references when the reference list fails', async () => {
    referenceProvider.getReferences.mockRejectedValue(new ProviderError('crossref', 'down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await api.get('/api/works/W1/cited');

    expect(res.status).toBe(200);
    expect(res.body.works.map((w) => w.title)).toEqual(['Work W2']);
  });
});

describe('citation links from OpenCitations', () => {
  // OpenAlex has W8, W9 and W10 but doesn't link them to W1: W8 and W9 cite W1, W1 cites W10.
  // OpenCitations knows those links, plus W4 → W1 and W1 → W2, which OpenAlex already has.
  const unlinked = [
    providerWork('W8', { citedByCount: 7 }),
    providerWork('W9', { doi: '10.1234/w9', citedByCount: 1 }),
    providerWork('W10'),
  ];
  let linkProvider;

  beforeEach(() => {
    const getWorks = provider.getWorks.getMockImplementation();
    provider.getWorks = vi.fn(async (ids) => [
      ...(await getWorks(ids)),
      ...unlinked.filter((w) => ids.includes(w.providerId)),
    ]);
    provider.getWorksByDoi = vi.fn(async (dois) =>
      unlinked.filter((w) => dois.includes(w.externalIds.doi)),
    );
    linkProvider = {
      name: 'opencitations',
      getCitingIds: vi.fn(async () => [
        { openalex: 'W8', doi: null },
        { openalex: null, doi: '10.1234/w9' },
        { openalex: 'W4', doi: null },
      ]),
      getCitedIds: vi.fn(async () => [
        { openalex: 'W2', doi: null },
        { openalex: 'W10', doi: null },
      ]),
    };
    const workService = createWorkService({ provider, linkProvider, now: () => clock });
    api = request(createApp({ workService }));
  });

  it('adds citing works OpenAlex has but does not link, most-cited first', async () => {
    const res = await api.get('/api/works/W1/citing');

    expect(res.status).toBe(200);
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W5', 'W8', 'W4', 'W9']);
    // The recovered links draw: W8 and W9 now list W1 among their references.
    const w1 = await tracerIdOf('W1');
    for (const work of res.body.works) expect(work.references).toContain(w1);
    expect(linkProvider.getCitingIds).toHaveBeenCalledWith('10.1234/root');
  });

  it('keeps the limit across both sources', async () => {
    const res = await api.get('/api/works/W1/citing?limit=2');
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W5', 'W8']);
  });

  it('adds cited works OpenAlex has but does not link', async () => {
    const res = await api.get('/api/works/W1/cited');
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W2', 'W10']);

    const { work } = (await api.get('/api/works/W1')).body;
    expect(work.references).toContain(await tracerIdOf('W10'));
    expect(work.providers).toEqual(['openalex', 'opencitations']);
  });

  it('caches the links it found', async () => {
    await api.get('/api/works/W1/citing');
    await api.get('/api/works/W1/citing?limit=10');
    expect(linkProvider.getCitingIds).toHaveBeenCalledTimes(1);

    advance(DEFAULT_TTLS.citing + 1);
    await api.get('/api/works/W1/citing');
    expect(linkProvider.getCitingIds).toHaveBeenCalledTimes(2);
  });

  it('falls back to OpenAlex alone when OpenCitations fails', async () => {
    linkProvider.getCitingIds.mockRejectedValue(new ProviderError('opencitations', 'timed out'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await api.get('/api/works/W1/citing');

    expect(res.status).toBe(200);
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W5', 'W4']);
  });
});

describe('GET /api/works/:id/archive', () => {
  const item = (identifier, overrides = {}) => ({
    identifier,
    title: 'Work W1',
    creators: ['Historian, A.'],
    year: 1972,
    access: 'borrow',
    url: `https://archive.org/details/${identifier}`,
    ...overrides,
  });
  let archiveProvider;

  beforeEach(() => {
    archiveProvider = {
      name: 'internetarchive',
      searchTexts: vi.fn(async () => [
        item('w1-borrow'),
        item('w1-open', { access: 'open', year: 1990 }),
        item('other-author', { creators: ['Someone, Else'] }),
        item('other-title', { title: 'Work W12' }),
      ]),
    };
    const workService = createWorkService({ provider, archiveProvider, now: () => clock });
    api = request(createApp({ workService }));
  });

  it('returns the matching items, open ones first, and caches them for 30 days', async () => {
    const res = await api.get('/api/works/W1/archive');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.identifier)).toEqual(['w1-open', 'w1-borrow']);
    expect(archiveProvider.searchTexts).toHaveBeenCalledWith(['work', 'w1']);

    await api.get('/api/works/W1/archive');
    expect(archiveProvider.searchTexts).toHaveBeenCalledTimes(1);
    advance(DEFAULT_TTLS.archive + 1);
    await api.get('/api/works/W1/archive');
    expect(archiveProvider.searchTexts).toHaveBeenCalledTimes(2);
  });

  it('doesn’t list the Archive among the work’s data providers', async () => {
    await api.get('/api/works/W1/archive');
    expect((await api.get('/api/works/W1')).body.work.providers).toEqual(['openalex']);
  });

  it('checks works not on OpenAlex too, by their deposited citation', async () => {
    const citation = {
      doi: null,
      title: 'Deccani Painting',
      authors: [{ name: 'Zebrowski', orcid: null }],
      year: 1983,
      venue: null,
      unstructured: null,
    };
    const structured = await Source.create({
      citation,
      externalIds: { citation: citationKey(citation) },
    });
    archiveProvider.searchTexts.mockResolvedValue([
      item('deccani', { title: 'Deccani painting', creators: ['Zebrowski, Mark'], year: 1983 }),
    ]);

    const res = await api.get(`/api/works/${structured._id}/archive`);
    expect(res.status).toBe(200);
    expect(archiveProvider.searchTexts).toHaveBeenCalledWith(['deccani', 'painting']);
    expect(res.body.items.map((i) => i.identifier)).toEqual(['deccani']);
    // Still a reference-only work afterwards.
    const { work } = (await api.get(`/api/works/${structured._id}`)).body;
    expect(work).toMatchObject({ type: REFERENCE_ONLY, providers: ['crossref'] });
  });

  it('skips works known only from a citation printed as text', async () => {
    const printed = {
      doi: null,
      title: null,
      authors: [],
      year: 1991,
      venue: null,
      unstructured: 'Africa Watch. Evil Days. New York, 1991.',
    };
    const source = await Source.create({
      citation: printed,
      externalIds: { citation: citationKey(printed) },
    });

    const res = await api.get(`/api/works/${source._id}/archive`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(archiveProvider.searchTexts).not.toHaveBeenCalled();
  });

  it('gives the cached items, or none, when the Archive fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await api.get('/api/works/W1/archive');
    advance(DEFAULT_TTLS.archive + 1);
    archiveProvider.searchTexts.mockRejectedValue(new ProviderError('internetarchive', 'down'));
    const stale = await api.get('/api/works/W1/archive');
    expect(stale.body.items).toHaveLength(2);

    const none = await api.get('/api/works/W2/archive');
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([]);
  });
});

describe('citationKey', () => {
  it('ignores case, punctuation and accents, preferring DOI, then title, then the citation', () => {
    const base = { doi: null, authors: [{ name: 'Zebrowski' }], year: 1983, unstructured: null };
    expect(citationKey({ ...base, title: 'Deccani Painting' })).toBe(
      citationKey({ ...base, title: 'Deccani painting.', authors: [{ name: 'ZEBROWSKI' }] }),
    );
    expect(citationKey({ ...base, title: 'Café' })).toBe(citationKey({ ...base, title: 'Cafe' }));
    expect(citationKey({ ...base, title: 'X', doi: '10.1234/x' })).toBe('d:10.1234/x');
    expect(citationKey({ ...base, title: null, unstructured: 'A. B.' })).toBe('u:ab');
    expect(citationKey({ ...base, title: null, authors: [] })).toBeNull();
  });
});

describe('GET /api/works?q=', () => {
  it('searches and caches by normalized query', async () => {
    const first = await api.get('/api/works?q=Moral%20Economy&limit=2');
    await api.get('/api/works?q=%20moral%20%20economy%20&limit=2');

    expect(first.status).toBe(200);
    expect(first.body.works).toHaveLength(2);
    expect(provider.searchWorks).toHaveBeenCalledTimes(1);
    expect(provider.searchWorks).toHaveBeenCalledWith('moral economy', { limit: 2 });
  });

  it('requires q', async () => {
    expect((await api.get('/api/works')).status).toBe(400);
    expect((await api.get('/api/works?q=%20')).status).toBe(400);
  });
});

describe('validation and errors', () => {
  it.each(['0', '201', '1.5', 'abc'])('rejects limit=%s', async (limit) => {
    expect((await api.get(`/api/works/W1/citing?limit=${limit}`)).status).toBe(400);
  });

  it('maps provider rate limiting to 503', async () => {
    provider.getWork.mockRejectedValueOnce(new ProviderError('openalex', 'x', { status: 429 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await api.get('/api/works/W1');

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/rate limit/);
  });

  it('maps other provider failures to 502', async () => {
    provider.getWork.mockRejectedValueOnce(new ProviderError('openalex', 'x', { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await api.get('/api/works/W1')).status).toBe(502);
  });
});

describe('without a database connection', () => {
  it('returns 503', async () => {
    await mongoose.disconnect();
    try {
      const res = await api.get('/api/works/W1');
      expect(res.status).toBe(503);
      expect(provider.getWork).not.toHaveBeenCalled();
    } finally {
      await mongoose.connect(mongo.getUri());
    }
  });
});

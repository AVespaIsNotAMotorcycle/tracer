import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/authService.js';
import { Identity } from '../models/Identity.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
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
    searchWorksAdvanced: vi.fn(async (criteria, { limit, page }) => ({
      works: [...catalog.values()].slice((page - 1) * limit, page * limit),
      total: catalog.size,
    })),
    suggest: vi.fn(async () => [{ id: 'S1', name: 'Past & Present', hint: null, worksCount: 1 }]),
    // Links straight from the catalog's references, both ways.
    getNeighborIds: vi.fn(async (ids) => {
      const links = new Map();
      for (const id of ids) {
        links.set(id, [
          ...(catalog.get(id)?.referencedIds ?? []).map((other) => ({ id: other, link: 'cites' })),
          ...[...catalog.values()]
            .filter((w) => w.referencedIds.includes(id))
            .map((w) => ({ id: w.providerId, link: 'cited-by' })),
        ]);
      }
      return { links, counts: new Map(), complete: true };
    }),
    getCitationCounts: vi.fn(
      async (ids) => new Map(ids.map((id) => [id, catalog.get(id)?.citedByCount ?? 0])),
    ),
    // Citing works by year: every catalog work is from 1971.
    getCitationsByYear: vi.fn(async (ids) => {
      const count = [...catalog.values()].filter((w) =>
        w.referencedIds.some((id) => ids.includes(id)),
      ).length;
      return count ? [{ year: 1971, count }] : [];
    }),
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

  it('falls back on the language deposited with Crossref, and gives its other titles', async () => {
    referenceProvider.getRecord = vi.fn(async (doi) => ({
      references: (deposited[doi] ?? []).map(reference),
      title: '清代满洲史',
      originalTitle: null,
      language: 'zh',
    }));
    await api.get('/api/works/W1/cited');
    const { work } = (await api.get('/api/works/W1')).body;
    expect(work).toMatchObject({
      language: 'zh',
      languageProvider: 'crossref',
      otherTitles: [{ title: '清代满洲史', kind: 'alternate', script: 'han' }],
    });
    expect(referenceProvider.getReferences).not.toHaveBeenCalled();
  });

  it('says which provider has each citation', async () => {
    const [w2, w6, painting] = (await api.get('/api/works/W1/cited')).body.works;
    const { work } = (await api.get('/api/works/W1')).body;

    expect(work.referenceProviders[w2.id]).toEqual(['openalex']);
    expect(work.referenceProviders[await tracerIdOf('W3')]).toEqual(['openalex']);
    expect(work.referenceProviders[w6.id]).toEqual(['crossref']);
    expect(work.referenceProviders[painting.id]).toEqual(['crossref']);
    expect(Object.keys(work.referenceProviders)).toEqual(work.references);
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
    expect(work.referenceProviders[await tracerIdOf('W10')]).toEqual(['opencitations']);
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
    expect(archiveProvider.searchTexts).toHaveBeenCalledWith(['work', 'w1'], { anyField: false });

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
    expect(archiveProvider.searchTexts).toHaveBeenCalledWith(['deccani', 'painting'], {
      anyField: false,
    });
    expect(res.body.items.map((i) => i.identifier)).toEqual(['deccani']);
    // Still a reference-only work afterwards.
    const { work } = (await api.get(`/api/works/${structured._id}`)).body;
    expect(work).toMatchObject({ type: REFERENCE_ONLY, providers: ['crossref'] });
  });

  it('searches a citation printed as text by its words, matching against the text', async () => {
    const printed = {
      doi: null,
      title: null,
      authors: [],
      year: 1963,
      venue: null,
      unstructured:
        'B.H. Slicher van Bath, The Agrarian History of Western Europe, A.D. 500–1850, (London, 1963), pp. 207–208.',
    };
    const source = await Source.create({
      citation: printed,
      externalIds: { citation: citationKey(printed) },
    });
    archiveProvider.searchTexts.mockResolvedValue([
      item('agrarianhistoryo0000slic', {
        title: 'The agrarian history of Western Europe, A.D. 500-1850',
        creators: ['Slicher van Bath, B. H'],
        year: 1963,
      }),
      item('agrarianconditio0000warn', {
        title: 'Agrarian conditions in modern European history',
        creators: ['Warner, Charles K.'],
      }),
    ]);

    const res = await api.get(`/api/works/${source._id}/archive`);
    expect(res.body.items.map((i) => i.identifier)).toEqual(['agrarianhistoryo0000slic']);
    expect(archiveProvider.searchTexts).toHaveBeenCalledWith(
      ['slicher', 'van', 'bath', 'agrarian', 'history', 'western', 'europe'],
      { anyField: true },
    );
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

describe('GET /api/works/:id/match', () => {
  const fairbank = {
    doi: null,
    title: "The Manchu-Chinese Dyarchy in the 1840's and '50's",
    authors: [{ name: 'Fairbank', orcid: null }],
    year: 1953,
    venue: 'Far Eastern Quarterly',
    unstructured: null,
  };
  const found = {
    doi: '10.2307/2942138',
    title: "The Manchu-Chinese Dyarchy in the 1840's and '50's",
    authors: [{ name: 'John K. Fairbank', family: 'Fairbank' }],
    year: 1953,
    type: 'journal-article',
    venue: 'The Far Eastern Quarterly',
    url: 'https://www.jstor.org/stable/2942138',
  };
  let referenceProvider;
  let source;

  beforeEach(async () => {
    referenceProvider = {
      name: 'crossref',
      getReferences: vi.fn(async () => []),
      searchCitation: vi.fn(async () => [found]),
    };
    const workService = createWorkService({ provider, referenceProvider, now: () => clock });
    api = request(createApp({ workService }));
    source = await Source.create({
      citation: fairbank,
      externalIds: { citation: citationKey(fairbank) },
    });
  });

  it('matches a reference-only work, with links to it, and caches it for 30 days', async () => {
    const res = await api.get(`/api/works/${source._id}/match`);
    expect(res.status).toBe(200);
    expect(res.body.match).toEqual({
      ...found,
      links: [
        { kind: 'doi', url: 'https://doi.org/10.2307/2942138' },
        { kind: 'jstor', url: 'https://www.jstor.org/stable/10.2307/2942138' },
      ],
    });
    expect(referenceProvider.searchCitation).toHaveBeenCalledWith(
      "Fairbank The Manchu-Chinese Dyarchy in the 1840's and '50's Far Eastern Quarterly 1953",
    );

    await api.get(`/api/works/${source._id}/match`);
    expect(referenceProvider.searchCitation).toHaveBeenCalledTimes(1);
    advance(DEFAULT_TTLS.citationMatch + 1);
    await api.get(`/api/works/${source._id}/match`);
    expect(referenceProvider.searchCitation).toHaveBeenCalledTimes(2);
  });

  it('caches a miss too', async () => {
    referenceProvider.searchCitation.mockResolvedValue([{ ...found, title: 'Something else' }]);
    expect((await api.get(`/api/works/${source._id}/match`)).body.match).toBeNull();
    await api.get(`/api/works/${source._id}/match`);
    expect(referenceProvider.searchCitation).toHaveBeenCalledTimes(1);
  });

  it('gives no match for works on OpenAlex, without searching', async () => {
    expect((await api.get('/api/works/W1/match')).body.match).toBeNull();
    expect(referenceProvider.searchCitation).not.toHaveBeenCalled();
  });

  it('merges the work into the matched work when OpenAlex has it, once', async () => {
    const dyarchy = {
      ...providerWork('W40', { doi: '10.2307/2942138', citedByCount: 12 }),
      title: found.title,
      authors: [{ name: 'John King Fairbank', orcid: null }],
      year: 1953,
    };
    provider.getWorksByDoi = vi.fn(async (dois) =>
      dois.includes(dyarchy.externalIds.doi) ? [dyarchy] : [],
    );
    const res = await api.get(`/api/works/${source._id}/match`);

    expect(res.body.match.doi).toBe('10.2307/2942138');
    expect(res.body.work).toMatchObject({
      id: await tracerIdOf('W40'),
      mergedIds: [String(source._id)],
      citedByCount: 12,
    });
    expect((await api.get(`/api/works/${source._id}`)).body.work.id).toBe(res.body.work.id);
    const again = await api.get(`/api/works/${source._id}/match`);
    expect(again.body.work.id).toBe(res.body.work.id);
    expect(referenceProvider.searchCitation).toHaveBeenCalledTimes(1);
    expect(provider.getWorksByDoi).toHaveBeenCalledTimes(1);
  });

  it('doesn’t merge into a matched work whose record disagrees, or look it up again', async () => {
    provider.getWorksByDoi = vi.fn(async () => [
      { ...providerWork('W41', { doi: '10.2307/2942138' }), title: 'A Review', year: 1953 },
    ]);
    const res = await api.get(`/api/works/${source._id}/match`);
    expect(res.body.match.doi).toBe('10.2307/2942138');
    expect(res.body.work).toBeUndefined();
    await api.get(`/api/works/${source._id}/match`);
    expect(provider.getWorksByDoi).toHaveBeenCalledTimes(1);
    expect((await api.get(`/api/works/${source._id}`)).body.work.type).toBe(REFERENCE_ONLY);
  });

  it('gives the cached match, or none, when Crossref fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await api.get(`/api/works/${source._id}/match`);
    advance(DEFAULT_TTLS.citationMatch + 1);
    referenceProvider.searchCitation.mockRejectedValue(new ProviderError('crossref', 'down'));
    const res = await api.get(`/api/works/${source._id}/match`);
    expect(res.status).toBe(200);
    expect(res.body.match.doi).toBe('10.2307/2942138');
  });
});

describe('language and stored record versions', () => {
  it('gives the language OpenAlex detected', async () => {
    catalog.set('W60', { ...providerWork('W60'), language: 'fr' });
    try {
      const { work } = (await api.get('/api/works/W60')).body;
      expect(work).toMatchObject({ language: 'fr', languageProvider: 'openalex', otherTitles: [] });
    } finally {
      catalog.delete('W60');
    }
  });

  it('fetches again a record stored before the current version', async () => {
    await api.get('/api/works/W1');
    expect(provider.getWork).toHaveBeenCalledTimes(1);
    await api.get('/api/works/W1');
    expect(provider.getWork).toHaveBeenCalledTimes(1);

    await Source.updateOne(
      { 'externalIds.openalex': 'W1' },
      { $unset: { 'records.openalex.version': 1 } },
    );
    await api.get('/api/works/W1');
    expect(provider.getWork).toHaveBeenCalledTimes(2);
  });
});

describe('merging duplicate works', () => {
  const titled = (id, fields, extra = {}) => ({ ...providerWork(id, fields), ...extra });
  const added = [];
  const add = (...works) => {
    for (const work of works) {
      catalog.set(work.providerId, work);
      added.push(work.providerId);
    }
  };

  afterEach(() => {
    for (const id of added.splice(0)) catalog.delete(id);
  });

  it('merges two records with one DOI into the more cited, adding up their citations', async () => {
    add(
      titled(
        'W20',
        { doi: '10.5555/dup', citedByCount: 10, referencedIds: ['W2'] },
        { title: 'Moral Economy' },
      ),
      titled(
        'W21',
        { doi: '10.5555/dup', citedByCount: 3, referencedIds: ['W4'] },
        { title: 'Moral economy.' },
      ),
      providerWork('W22', { referencedIds: ['W21'], citedByCount: 1 }),
      providerWork('W23', { referencedIds: ['W20'], citedByCount: 2 }),
    );
    const main = (await api.get('/api/works/W20')).body.work;
    const dup = (await api.get('/api/works/W21')).body.work;
    const dupId = await tracerIdOf('W21');

    expect(dup.id).toBe(main.id);
    expect(dup).toMatchObject({ citedByCount: 13, mergedIds: [dupId] });
    expect(dup.references).toEqual([await tracerIdOf('W2'), await tracerIdOf('W4')]);
    // The duplicate's own Tracer ID leads to the merged work.
    expect((await api.get(`/api/works/${dupId}`)).body.work.id).toBe(main.id);

    // Works citing either record cite the merged work.
    const citing = (await api.get(`/api/works/${dupId}/citing`)).body.works;
    expect(citing.map((w) => w.externalIds.openalex)).toEqual(['W23', 'W22']);
    for (const work of citing) expect(work.references).toEqual([main.id]);
    const cited = (await api.get('/api/works/W20/cited')).body.works;
    expect(cited.map((w) => w.externalIds.openalex)).toEqual(['W2', 'W4']);
  });

  it('doesn’t merge records that share a DOI but aren’t the same work', async () => {
    add(
      titled('W30', { doi: '10.5555/book' }, { title: 'The Great Arch', type: 'book' }),
      titled(
        'W31',
        { doi: '10.5555/book' },
        { title: 'The Great Arch', authors: [{ name: 'A. Reviewer', orcid: null }] },
      ),
      titled('W32', { doi: '10.5555/book' }, { title: 'The Great Arch', type: 'book', year: 1990 }),
    );
    await api.get('/api/works/W30');
    await api.get('/api/works/W31');
    await api.get('/api/works/W32');
    const ids = new Set(
      await Promise.all(
        ['W30', 'W31', 'W32'].map(async (id) => (await api.get(`/api/works/${id}`)).body.work.id),
      ),
    );
    expect(ids.size).toBe(3);
    expect(await Source.countDocuments({ mergedInto: { $exists: true } })).toBe(0);
  });
});

describe('GET /api/works/:id/citations-by-year', () => {
  it('counts the works citing it each year, cached for a week', async () => {
    const res = await api.get('/api/works/W1/citations-by-year');
    expect(res.status).toBe(200);
    expect(res.body.years).toEqual([{ year: 1971, count: 2 }]);
    await api.get('/api/works/W1/citations-by-year');
    expect(provider.getCitationsByYear).toHaveBeenCalledTimes(1);
    advance(DEFAULT_TTLS.citing + 1);
    await api.get('/api/works/W1/citations-by-year');
    expect(provider.getCitationsByYear).toHaveBeenCalledTimes(2);
  });

  it('gives the cached years when the provider fails, and the error without any', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    provider.getCitationsByYear.mockRejectedValueOnce(new ProviderError('openalex', 'down'));
    expect((await api.get('/api/works/W1/citations-by-year')).status).toBe(502);
    await api.get('/api/works/W1/citations-by-year');
    advance(DEFAULT_TTLS.citing + 1);
    provider.getCitationsByYear.mockRejectedValueOnce(new ProviderError('openalex', 'down'));
    const res = await api.get('/api/works/W1/citations-by-year');
    expect(res.body.years).toEqual([{ year: 1971, count: 2 }]);
  });
});

describe('GET /api/works/:id/authors', () => {
  let nameProvider;

  beforeEach(() => {
    catalog.set('W70', {
      ...providerWork('W70', { doi: '10.1234/maruyama' }),
      authors: [
        { name: 'Masao Maruyama', orcid: null },
        { name: 'A. Translator', orcid: '0000-0001-2345-6789' },
      ],
    });
    nameProvider = {
      name: 'wikidata',
      findByDoi: vi.fn(async () => 'Q9'),
      findByOrcid: vi.fn(async () => 'Q7'),
      getWorkCredits: vi.fn(async () => [{ id: 'Q1143571', ordinal: 1, statedAs: null }]),
      getPeople: vi.fn(async (ids) =>
        [
          {
            id: 'Q1143571',
            labels: { en: 'Masao Maruyama', ja: '丸山眞男' },
            aliases: [],
            nativeNames: [{ text: '丸山眞男', language: 'ja' }],
            kanaReadings: ['まるやま まさお'],
            languages: ['ja'],
            orcid: null,
            viaf: '44407375',
          },
          {
            id: 'Q7',
            labels: { en: 'A. Translator' },
            aliases: [],
            nativeNames: [],
            kanaReadings: [],
            languages: [],
            orcid: '0000-0001-2345-6789',
            viaf: null,
          },
        ].filter((p) => ids.includes(p.id)),
      ),
    };
    const workService = createWorkService({ provider, nameProvider, now: () => clock });
    api = request(createApp({ workService }));
  });

  afterEach(() => catalog.delete('W70'));

  it('gives the authors Wikidata knows, with their names in other scripts, cached', async () => {
    const res = await api.get('/api/works/W70/authors');
    expect(res.status).toBe(200);
    expect(res.body.authors).toEqual([
      {
        index: 0,
        name: 'Masao Maruyama',
        wikidata: 'Q1143571',
        otherNames: [
          { text: '丸山眞男', language: 'ja', reading: 'まるやま まさお', kind: 'native' },
        ],
        links: [
          { kind: 'wikidata', url: 'https://www.wikidata.org/wiki/Q1143571' },
          { kind: 'viaf', url: 'https://viaf.org/viaf/44407375' },
        ],
      },
      {
        index: 1,
        name: 'A. Translator',
        wikidata: 'Q7',
        otherNames: [],
        links: [{ kind: 'wikidata', url: 'https://www.wikidata.org/wiki/Q7' }],
      },
    ]);
    expect(nameProvider.findByDoi).toHaveBeenCalledWith('10.1234/maruyama');
    expect(nameProvider.findByOrcid).toHaveBeenCalledWith('0000-0001-2345-6789');

    await api.get('/api/works/W70/authors');
    expect(nameProvider.findByDoi).toHaveBeenCalledTimes(1);
    // Not a provider of the work's data.
    expect((await api.get('/api/works/W70')).body.work.providers).toEqual(['openalex']);
  });

  it('gives the cached authors, or none, when Wikidata fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    nameProvider.findByDoi.mockRejectedValue(new ProviderError('wikidata', 'down'));
    const res = await api.get('/api/works/W70/authors');
    expect(res.status).toBe(200);
    expect(res.body.authors).toEqual([]);
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

  it('puts works with no links last, keeping the provider’s order otherwise', async () => {
    // The fake provider returns W1, W2, W4, W5. Nothing cites W2 and it cites nothing.
    const res = await api.get('/api/works?q=anything&limit=4');
    expect(res.body.works.map((w) => w.externalIds.openalex)).toEqual(['W1', 'W4', 'W5', 'W2']);
  });

  it('requires q', async () => {
    expect((await api.get('/api/works')).status).toBe(400);
    expect((await api.get('/api/works?q=%20')).status).toBe(400);
  });
});

describe('GET /api/works/search', () => {
  it('returns a page of works with Tracer IDs and the total, and caches it', async () => {
    const url = '/api/works/search?title=moral&types=book,article&fromYear=1960&limit=2&page=2';
    const first = await api.get(url);
    const again = await api.get(url);

    expect(first.status).toBe(200);
    expect(first.body.total).toBe(4);
    expect(first.body.works.map((w) => w.externalIds.openalex)).toEqual(['W4', 'W5']);
    expect(first.body.works[0].id).toBe(await tracerIdOf('W4'));
    expect(again.body).toEqual(first.body);
    expect(provider.searchWorksAdvanced).toHaveBeenCalledTimes(1);
    expect(provider.searchWorksAdvanced).toHaveBeenCalledWith(
      { title: 'moral', types: ['book', 'article'], fromYear: 1960 },
      { limit: 2, page: 2 },
    );
  });

  it('passes every field through', async () => {
    await api.get(
      '/api/works/search?any=a&title=b&author=c&abstract=d&fulltext=e&venue=S1,S2' +
        '&publisher=P1&toYear=1990&language=FR&minCitations=5&openAccess=true&sort=oldest',
    );
    expect(provider.searchWorksAdvanced).toHaveBeenCalledWith(
      {
        any: 'a',
        title: 'b',
        author: 'c',
        abstract: 'd',
        fulltext: 'e',
        venueIds: ['S1', 'S2'],
        publisherIds: ['P1'],
        toYear: 1990,
        language: 'fr',
        minCitations: 5,
        openAccess: true,
        sort: 'oldest',
      },
      { limit: 50, page: 1 },
    );
  });

  it.each([
    ['nothing to search', 'sort=cited'],
    ['a blank field', 'title=%20'],
    ['a bad year', 'fromYear=19x0'],
    ['years out of order', 'fromYear=2000&toYear=1990'],
    ['a bad venue ID', 'venue=S1,openalex:W1'],
    ['a bad type', 'types=book|article'],
    ['a bad language', 'language=french'],
    ['a bad sort', 'title=a&sort=random'],
    ['a page past the 10,000th result', 'title=a&limit=100&page=101'],
  ])('rejects %s', async (_, query) => {
    expect((await api.get(`/api/works/search?${query}`)).status).toBe(400);
    expect(provider.searchWorksAdvanced).not.toHaveBeenCalled();
  });
});

describe('GET /api/works/suggest/:kind', () => {
  it('suggests venues and publishers', async () => {
    const res = await api.get('/api/works/suggest/venue?q=past');
    expect(res.status).toBe(200);
    expect(res.body.suggestions[0].name).toBe('Past & Present');
    expect(provider.suggest).toHaveBeenCalledWith('venue', 'past');
    expect((await api.get('/api/works/suggest/publisher?q=oup')).status).toBe(200);
  });

  it('rejects unknown kinds and a missing query', async () => {
    expect((await api.get('/api/works/suggest/author?q=x')).status).toBe(404);
    expect((await api.get('/api/works/suggest/venue')).status).toBe(400);
  });
});

describe('GET /api/works/:id/path', () => {
  it('returns the shortest path as works with Tracer IDs, and how each step links', async () => {
    // W2 is cited by W1, which is cited by W5 (and W4, cited less).
    const res = await api.get('/api/works/W2/path?to=W5');

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('found');
    expect(res.body.path.map((step) => [step.work.externalIds.openalex, step.link])).toEqual([
      ['W2', null],
      ['W1', 'cited-by'],
      ['W5', 'cited-by'],
    ]);
    expect(res.body.path[1].work.id).toBe(await tracerIdOf('W1'));
  });

  it('finds a path to the nearest of several works', async () => {
    // W2 is cited by W1 (one step); W5 is two steps away.
    const res = await api.get('/api/works/W2/path?to=W5,W1');

    expect(res.status).toBe(200);
    expect(res.body.path.map((step) => step.work.externalIds.openalex)).toEqual(['W2', 'W1']);
  });

  it('needs a work to find a path to, other than the work itself', async () => {
    expect((await api.get('/api/works/W1/path')).status).toBe(400);
    expect((await api.get('/api/works/W1/path?to=W1')).status).toBe(400);
    expect((await api.get('/api/works/W1/path?to=W2,W1')).status).toBe(400);
    expect((await api.get('/api/works/W1/path?to=W2,W3,W4,W5,W6,W7,W8')).status).toBe(400);
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

describe('entitlements on works routes', () => {
  let agent;

  beforeEach(async () => {
    await Promise.all([User, Identity, Session].map((model) => model.deleteMany({})));
    const workService = createWorkService({ provider, now: () => clock });
    agent = request.agent(createApp({ workService, authService: createAuthService() }));
  });

  const signUpWith = async (planOverrides) => {
    await agent
      .post('/api/auth/signup')
      .send({ email: 'a@example.org', password: 'correct horse' });
    await User.updateOne({}, { planOverrides });
  };

  it('are open to signed-out visitors as before', async () => {
    expect((await agent.get('/api/works/W2/path?to=W5')).status).toBe(200);
    expect((await agent.get('/api/works/W1/cited?limit=200')).status).toBe(200);
  });

  it('refuse features the plan lacks, naming them', async () => {
    await signUpWith({ features: { pathSearch: false, advancedSearch: false } });

    const path = await agent.get('/api/works/W2/path?to=W5');
    expect(path.status).toBe(403);
    expect(path.body.feature).toBe('pathSearch');
    expect((await agent.get('/api/works/search?title=moral')).body.feature).toBe('advancedSearch');
    expect((await agent.get('/api/works/W1')).status).toBe(200);
  });

  it('cap citing and cited lists at works per node', async () => {
    await signUpWith({ limits: { perNode: 10 } });

    expect((await agent.get('/api/works/W1/cited?limit=10')).status).toBe(200);
    const over = await agent.get('/api/works/W1/citing?limit=11');
    expect(over.status).toBe(403);
    expect(over.body).toEqual({
      error: 'Your plan allows at most 10 works per node',
      limit: 'perNode',
    });
    expect(provider.getCitingWorks).not.toHaveBeenCalled();
    // Without a limit, the default shrinks to fit.
    await agent.get('/api/works/W1/citing');
    expect(provider.getCitingWorks).toHaveBeenCalledWith(expect.anything(), { limit: 10 });
    // Search pages aren't works per node.
    expect((await agent.get('/api/works?q=moral&limit=50')).status).toBe(200);
  });
});

import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { CacheEntry } from '../models/CacheEntry.js';
import { Source } from '../models/Source.js';
import { ProviderError } from '../providers/errors.js';
import { normalizeDoi } from '../providers/ids.js';
import { createWorkService, DEFAULT_TTLS } from './workService.js';

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

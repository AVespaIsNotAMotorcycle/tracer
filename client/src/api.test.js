import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCiting, getWork, looksLikeWorkId } from './api.js';

describe('looksLikeWorkId', () => {
  it.each([
    '10.1093/past/50.1.76',
    'https://doi.org/10.1093/past/50.1.76',
    'doi:10.1234/x',
    'W2043699734',
    'https://openalex.org/W1',
  ])('treats %s as an ID', (input) => expect(looksLikeWorkId(input)).toBe(true));

  it.each(['moral economy', 'Thompson 1971', 'W2043699734 crowd'])(
    'treats %s as a query',
    (input) => expect(looksLikeWorkId(input)).toBe(false),
  );
});

describe('requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (body, status = 200) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('URL-encodes IDs so DOIs survive', async () => {
    const fetch = stubFetch({ work: { id: 'x' } });

    await getWork('10.1093/past/50.1.76');

    expect(fetch.mock.calls[0][0]).toBe('/api/works/10.1093%2Fpast%2F50.1.76');
  });

  it('passes the limit', async () => {
    const fetch = stubFetch({ works: [] });

    await getCiting('abc', { limit: 7 });

    expect(fetch.mock.calls[0][0]).toBe('/api/works/abc/citing?limit=7');
  });

  it("throws the server's error message", async () => {
    stubFetch({ error: 'Work not found: W1' }, 404);

    await expect(getWork('W1')).rejects.toThrow('Work not found: W1');
  });
});

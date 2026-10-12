import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors.js';
import { createOpenCitationsProvider, parseIds } from './opencitations.js';

const jsonResponse = (body, { status = 200 } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// In the shape the live Index API returns.
const link = (citing, cited) => ({
  oci: '06301011599-061202735841',
  citing,
  cited,
  creation: '2015-06-29',
  timespan: 'P4Y8M15D',
  journal_sc: 'no',
  author_sc: 'no',
});

describe('parseIds', () => {
  it('picks out the DOI and OpenAlex ID', () => {
    expect(
      parseIds(
        'omid:br/061202735841 doi:10.1017/CBO9780511781254 isbn:9780521880589 openalex:W4240092462',
      ),
    ).toEqual({ doi: '10.1017/cbo9780511781254', openalex: 'W4240092462' });
  });

  it('leaves missing IDs null', () => {
    expect(parseIds('omid:br/06013144731 doi:10.1093/9780191996047.002.0010')).toEqual({
      doi: '10.1093/9780191996047.002.0010',
      openalex: null,
    });
    expect(parseIds('omid:br/1 isbn:9780198890768')).toEqual({ doi: null, openalex: null });
  });
});

describe('createOpenCitationsProvider', () => {
  const root = 'omid:br/1 openalex:W1 doi:10.1234/root';

  it('returns the other end of each reference or citation link', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([link(root, 'omid:br/2 openalex:W2')]))
      .mockResolvedValueOnce(jsonResponse([link('omid:br/3 doi:10.1234/c', root)]));
    const provider = createOpenCitationsProvider({ fetch });

    expect(await provider.getCitedIds('https://doi.org/10.1234/ROOT')).toEqual([
      { doi: null, openalex: 'W2' },
    ]);
    expect(await provider.getCitingIds('10.1234/root')).toEqual([
      { doi: '10.1234/c', openalex: null },
    ]);
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/index/v2/references/doi:10.1234/root');
    expect(new URL(fetch.mock.calls[1][0]).pathname).toBe('/index/v2/citations/doi:10.1234/root');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('sends an access token when given one', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse([]));
    await createOpenCitationsProvider({ fetch, accessToken: 'token' }).getCitedIds('10.1234/a');
    expect(fetch.mock.calls[0][1].headers.authorization).toBe('token');
  });

  it('limits concurrent requests', async () => {
    let inFlight = 0;
    let most = 0;
    const fetch = vi.fn(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse([]);
    });
    const provider = createOpenCitationsProvider({ fetch, concurrency: 2 });
    await Promise.all(['a', 'b', 'c', 'd'].map((x) => provider.getCitingIds(`10.1234/${x}`)));
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(most).toBe(2);
  });

  it('treats an unknown DOI as having no links, and wraps failures', async () => {
    const sleep = vi.fn().mockResolvedValue();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 404 }))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const provider = createOpenCitationsProvider({ fetch, sleep });

    expect(await provider.getCitingIds('10.1234/missing')).toEqual([]);
    await expect(provider.getCitingIds('10.1234/slow')).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.getCitingIds('W1')).rejects.toBeInstanceOf(ProviderError);
  });
});

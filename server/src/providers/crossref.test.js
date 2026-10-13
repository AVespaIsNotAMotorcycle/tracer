import { describe, expect, it, vi } from 'vitest';
import { createCrossrefProvider, normalizeReference } from './crossref.js';
import { ProviderError } from './errors.js';

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function setup(...responses) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const sleep = vi.fn().mockResolvedValue();
  return { provider: createCrossrefProvider({ fetch, sleep }), fetch, sleep };
}

describe('normalizeReference', () => {
  it('maps a structured book reference', () => {
    // As Cambridge deposits them.
    expect(
      normalizeReference({
        key: '9781108647403_REFe-r-419',
        'volume-title': 'Deccani Painting',
        author: 'Zebrowski',
        year: '1983',
      }),
    ).toEqual({
      doi: null,
      title: 'Deccani Painting',
      authors: [{ name: 'Zebrowski', orcid: null }],
      year: 1983,
      venue: null,
      unstructured: null,
    });
  });

  it('maps an article reference, with its journal as the venue', () => {
    expect(
      normalizeReference({
        DOI: '10.1093/PAST/50.1.76',
        'article-title': 'The Moral Economy of the English Crowd',
        'journal-title': 'Past & Present',
        year: '1971a',
      }),
    ).toMatchObject({
      doi: '10.1093/past/50.1.76',
      title: 'The Moral Economy of the English Crowd',
      venue: 'Past & Present',
      year: 1971,
    });
  });

  it('takes the last year in a printed citation, since earlier ones may be in the title', () => {
    const { year } = normalizeReference({
      unstructured: 'Africa Watch. Evil Days. 30 Years of War, 1961–1991. New York, 1992a, 12.',
    });
    expect(year).toBe(1992);
    expect(normalizeReference({ unstructured: 'Ibid., 245.' }).year).toBeNull();
  });

  it('treats the volume as the venue of a chapter', () => {
    expect(
      normalizeReference({ 'article-title': 'Chapter', 'volume-title': 'Edited Volume' }),
    ).toMatchObject({ title: 'Chapter', venue: 'Edited Volume' });
  });

  it('keeps a citation deposited only as printed text', () => {
    // As Taylor & Francis deposits them.
    expect(
      normalizeReference({
        key: 'cit0001',
        unstructured: ' Africa Watch. Evil Days. New York: Human Rights Watch, 1991. ',
      }),
    ).toEqual({
      doi: null,
      title: null,
      authors: [],
      year: 1991,
      venue: null,
      unstructured: 'Africa Watch. Evil Days. New York: Human Rights Watch, 1991.',
    });
  });
});

describe('createCrossrefProvider', () => {
  it('fetches the reference list for a DOI', async () => {
    const { provider, fetch } = setup(
      jsonResponse({ message: { reference: [{ unstructured: 'A source.' }] } }),
    );
    expect(await provider.getReferences('https://doi.org/10.1017/ABC.005')).toEqual([
      expect.objectContaining({ unstructured: 'A source.' }),
    ]);
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/works/10.1017%2Fabc.005');
  });

  it('returns an empty list when no references were deposited, and null for unknown DOIs', async () => {
    const { provider } = setup(jsonResponse({ message: {} }), jsonResponse({}, { status: 404 }));
    expect(await provider.getReferences('10.1093/past/50.1.76')).toEqual([]);
    expect(await provider.getReferences('10.1234/missing')).toBeNull();
  });

  it('sends a contact address when given one', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ message: {} }));
    await createCrossrefProvider({ fetch, mailto: 'me@example.org' }).getReferences('10.1234/a');
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).searchParams.get('mailto')).toBe('me@example.org');
    expect(init.headers['User-Agent']).toContain('mailto:me@example.org');
  });

  it('runs one request at a time', async () => {
    let inFlight = 0;
    let most = 0;
    const fetch = vi.fn(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return jsonResponse({ message: {} });
    });
    const provider = createCrossrefProvider({ fetch });
    await Promise.all(
      ['10.1234/a', '10.1234/b', '10.1234/c'].map((doi) => provider.getReferences(doi)),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(most).toBe(1);
  });

  it('retries rate limiting, then gives up with a ProviderError', async () => {
    const limited = () => jsonResponse({}, { status: 429 });
    const { provider, sleep } = setup(limited(), jsonResponse({ message: {} }));
    expect(await provider.getReferences('10.1234/a')).toEqual([]);
    expect(sleep).toHaveBeenCalledOnce();

    const failing = setup(limited(), limited(), limited(), limited());
    await expect(failing.provider.getReferences('10.1234/a')).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects values that are not DOIs without a request', async () => {
    const { provider, fetch } = setup();
    await expect(provider.getReferences('W123')).rejects.toBeInstanceOf(ProviderError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('searchCitation', () => {
  const found = {
    DOI: '10.2307/2942138',
    title: ["The Manchu-Chinese Dyarchy in the 1840's and '50's"],
    author: [{ given: 'John K.', family: 'Fairbank' }],
    issued: { 'date-parts': [[1953, 2]] },
    type: 'journal-article',
    'container-title': ['The Far Eastern Quarterly'],
    resource: { primary: { URL: 'https://www.jstor.org/stable/2942138?origin=crossref' } },
  };

  it('searches by citation and returns candidate works', async () => {
    const { provider, fetch } = setup(
      jsonResponse({ message: { items: [found, { title: ['No DOI'] }] } }),
    );
    const works = await provider.searchCitation('Fairbank Manchu-Chinese Dyarchy 1953');
    expect(works).toEqual([
      {
        doi: '10.2307/2942138',
        title: "The Manchu-Chinese Dyarchy in the 1840's and '50's",
        authors: [{ name: 'John K. Fairbank', family: 'Fairbank' }],
        year: 1953,
        type: 'journal-article',
        venue: 'The Far Eastern Quarterly',
        url: 'https://www.jstor.org/stable/2942138?origin=crossref',
      },
    ]);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/works');
    expect(url.searchParams.get('query.bibliographic')).toBe(
      'Fairbank Manchu-Chinese Dyarchy 1953',
    );
    expect(url.searchParams.get('rows')).toBe('5');
  });
});

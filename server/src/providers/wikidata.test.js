import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors.js';
import { createWikidataProvider, normalizeCredits, normalizePerson } from './wikidata.js';

const jsonResponse = (body, { status = 200, headers = {} } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function setup(...responses) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  const sleep = vi.fn().mockResolvedValue();
  const provider = createWikidataProvider({ fetch, sleep, contact: 'team@example.org' });
  return { provider, fetch, sleep };
}

const statement = (value, qualifiers = {}) => ({
  mainsnak: { datavalue: { value } },
  qualifiers: Object.fromEntries(
    Object.entries(qualifiers).map(([property, text]) => [
      property,
      [{ datavalue: { value: text } }],
    ]),
  ),
});

// Maruyama Masao (Q1143571), as wbgetentities returns him, trimmed.
const maruyama = {
  id: 'Q1143571',
  labels: {
    en: { language: 'en', value: 'Masao Maruyama' },
    ja: { language: 'ja', value: '丸山眞男' },
  },
  aliases: { en: [{ language: 'en', value: 'Maruyama Masao' }] },
  claims: {
    P1559: [statement({ text: '丸山眞男', language: 'ja' })],
    P1814: [statement('まるやま まさお')],
    P1412: [statement({ id: 'Q5287' })],
    P214: [statement('44407375')],
  },
};

describe('normalizePerson', () => {
  it('keeps the names and identifiers Tracer uses', () => {
    expect(normalizePerson(maruyama)).toEqual({
      id: 'Q1143571',
      labels: { en: 'Masao Maruyama', ja: '丸山眞男' },
      aliases: ['Maruyama Masao'],
      nativeNames: [{ text: '丸山眞男', language: 'ja' }],
      kanaReadings: ['まるやま まさお'],
      languages: ['ja'],
      countryLanguages: [],
      orcid: null,
      viaf: '44407375',
    });
  });
});

describe('normalizeCredits', () => {
  it('lists the credited authors in order, those without a place last', () => {
    const entity = {
      claims: {
        P50: [
          statement({ id: 'Q3' }),
          statement({ id: 'Q2' }, { P1545: '2', P1932: 'B. Author' }),
          statement({ id: 'Q1' }, { P1545: '1' }),
        ],
      },
    };
    expect(normalizeCredits(entity)).toEqual([
      { id: 'Q1', ordinal: 1, statedAs: null },
      { id: 'Q2', ordinal: 2, statedAs: 'B. Author' },
      { id: 'Q3', ordinal: null, statedAs: null },
    ]);
  });
});

describe('createWikidataProvider', () => {
  it('finds a work’s item by its DOI, in upper case, naming a contact', async () => {
    const { provider, fetch } = setup(
      jsonResponse({ query: { search: [{ title: 'Q56137244' }] } }),
    );
    expect(await provider.findByDoi('https://doi.org/10.1093/past/50.1.76')).toBe('Q56137244');
    const [url, init] = fetch.mock.calls[0];
    expect(url.searchParams.get('srsearch')).toBe('haswbstatement:P356=10.1093/PAST/50.1.76');
    expect(init.headers['User-Agent']).toBe('Tracer/1.0 (citation graphs; team@example.org)');
  });

  it('gives null when nothing has the DOI, and refuses what isn’t one', async () => {
    const { provider } = setup(jsonResponse({ query: { search: [] } }));
    expect(await provider.findByDoi('10.1234/none')).toBeNull();
    await expect(provider.findByDoi('W123')).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.findByOrcid('not-an-orcid')).rejects.toBeInstanceOf(ProviderError);
  });

  it('reads a work’s credits and its authors', async () => {
    const { provider, fetch } = setup(
      jsonResponse({
        entities: { Q9: { id: 'Q9', claims: { P50: [statement({ id: 'Q1143571' })] } } },
      }),
      jsonResponse({ entities: { Q1143571: maruyama, Q404: { id: 'Q404', missing: '' } } }),
    );
    expect(await provider.getWorkCredits('Q9')).toEqual([
      { id: 'Q1143571', ordinal: null, statedAs: null },
    ]);
    const [person] = await provider.getPeople(['Q1143571', 'Q404']);
    expect(person.nativeNames).toEqual([{ text: '丸山眞男', language: 'ja' }]);
    expect(fetch.mock.calls[1][0].searchParams.get('ids')).toBe('Q1143571|Q404');
  });

  it('waits and retries when throttled, then reports a failure', async () => {
    const { provider, sleep } = setup(
      jsonResponse({}, { status: 429, headers: { 'retry-after': '3' } }),
      jsonResponse({ query: { search: [{ title: 'Q1' }] } }),
    );
    expect(await provider.findByOrcid('0000-0003-1613-5981')).toBe('Q1');
    expect(sleep).toHaveBeenCalledWith(3000);

    const dropped = setup(jsonResponse({ query: { search: [] } }));
    dropped.fetch.mockReset();
    dropped.fetch
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ query: { search: [] } }));
    expect(await dropped.provider.findByOrcid('0000-0003-1613-5981')).toBeNull();
    expect(dropped.sleep).toHaveBeenCalledTimes(1);

    const failing = setup(jsonResponse({ error: { info: 'bad request' } }));
    await expect(failing.provider.findByOrcid('0000-0003-1613-5981')).rejects.toThrow(
      'bad request',
    );
  });
});

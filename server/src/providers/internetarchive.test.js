import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from './errors.js';
import { createInternetArchiveProvider, normalizeItem } from './internetarchive.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('normalizeItem', () => {
  it('reads who can access an item', () => {
    const access = (doc) => normalizeItem({ identifier: 'x', ...doc }).access;
    expect(access({ lending___status: 'is_readable' })).toBe('open');
    expect(access({})).toBe('open');
    expect(
      access({
        'access-restricted-item': 'true',
        lending___status: ['is_lendable', 'is_printdisabled'],
      }),
    ).toBe('borrow');
    expect(access({ 'access-restricted-item': 'true', lending___status: 'is_printdisabled' })).toBe(
      'print-disabled',
    );
  });

  it('accepts single values or lists', () => {
    expect(normalizeItem({ identifier: 'a b', title: ['T'], creator: 'C', year: '1906' })).toEqual({
      identifier: 'a b',
      title: 'T',
      creators: ['C'],
      year: 1906,
      access: 'open',
      url: 'https://archive.org/details/a%20b',
    });
  });
});

describe('searchTexts', () => {
  it('searches texts by title words', async () => {
    const fetch = vi.fn(async () =>
      json({ response: { docs: [{ identifier: 'geschichte', title: 'Geschichte von Japan' }] } }),
    );
    const archive = createInternetArchiveProvider({ fetch });
    const items = await archive.searchTexts(['geschichte', 'japan']);
    expect(items.map((i) => i.identifier)).toEqual(['geschichte']);
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.pathname).toBe('/advancedsearch.php');
    expect(url.searchParams.get('q')).toBe('title:(geschichte AND japan) AND mediatype:texts');
    expect(url.searchParams.getAll('fl[]')).toContain('lending___status');
  });

  it('searches all metadata fields when asked', async () => {
    const fetch = vi.fn(async () => json({ response: { docs: [] } }));
    await createInternetArchiveProvider({ fetch }).searchTexts(['slicher', 'agrarian'], {
      anyField: true,
    });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(url.searchParams.get('q')).toBe('(slicher AND agrarian) AND mediatype:texts');
  });

  it('fails on an error, even one sent as 200', async () => {
    const down = createInternetArchiveProvider({ fetch: async () => json({}, 503) });
    await expect(down.searchTexts(['x'])).rejects.toBeInstanceOf(ProviderError);
    const broken = createInternetArchiveProvider({
      fetch: async () => json({ error: '[BACKEND_ERROR] Invalid or no response' }),
    });
    await expect(broken.searchTexts(['x'])).rejects.toThrow(/BACKEND_ERROR/);
  });

  it('makes no request without words', async () => {
    const fetch = vi.fn();
    expect(await createInternetArchiveProvider({ fetch }).searchTexts([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

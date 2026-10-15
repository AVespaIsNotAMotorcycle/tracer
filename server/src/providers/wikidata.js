import { ProviderError } from './errors.js';
import { normalizeDoi } from './ids.js';

/**
 * An author of a work as its Wikidata item credits them ("author", P50).
 *
 * @typedef {object} WikidataCredit
 * @property {string} id  The author's item, e.g. "Q1143571".
 * @property {number | null} ordinal  Their place among the authors ("series ordinal", P1545).
 * @property {string | null} statedAs  Their name as printed on the work (P1932).
 */

/**
 * A person on Wikidata, with the names and identifiers Tracer uses.
 *
 * @typedef {object} WikidataPerson
 * @property {string} id
 * @property {Record<string, string>} labels  Their name by language code ("en", "ja", …).
 * @property {string[]} aliases  Other names, in any language.
 * @property {{ text: string, language: string }[]} nativeNames  Their name in their own
 *   language ("native label", P1559), e.g. { text: "丸山眞男", language: "ja" }.
 * @property {string[]} kanaReadings  How a Japanese name is read, in kana (P1814).
 * @property {string[]} languages  Language codes of their native language (P103) or the
 *   languages they wrote in (P1412), where Tracer knows the code.
 * @property {string[]} countryLanguages  The main language of the countries they're citizens
 *   of (P27), for the few countries whose names Tracer looks for in another script.
 * @property {string | null} orcid
 * @property {string | null} viaf
 */

const NAME = 'wikidata';
const DEFAULT_BASE_URL = 'https://www.wikidata.org/w/api.php';
// wbgetentities takes at most 50 IDs.
const MAX_IDS = 50;

// Language items Tracer can name as codes, for the languages a person wrote in.
const LANGUAGE_CODES = {
  Q5287: 'ja',
  Q7850: 'zh',
  Q727694: 'zh',
  Q9192: 'zh',
  Q9186: 'zh',
  Q9176: 'ko',
  Q7737: 'ru',
  Q8798: 'uk',
  Q13955: 'ar',
  Q9168: 'fa',
  Q9288: 'he',
  Q9129: 'el',
  Q1568: 'hi',
  Q9217: 'th',
};

// Countries whose citizens' names are usually written in a script other than Latin, and the
// language of their labels to look at. Researchers' items are often created by bots with a
// label in that language (長澤和也) but no native name or languages.
const COUNTRY_LANGUAGES = {
  Q17: 'ja',
  Q148: 'zh',
  Q865: 'zh',
  Q8646: 'zh',
  Q884: 'ko',
  Q423: 'ko',
  Q159: 'ru',
  Q212: 'uk',
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The values of an item's statements for one property. */
const values = (claims, property) =>
  (claims?.[property] ?? []).map((claim) => claim.mainsnak?.datavalue?.value).filter(Boolean);

/** One qualifier's first value, as text. */
const qualifier = (claim, property) => {
  const value = claim.qualifiers?.[property]?.[0]?.datavalue?.value;
  return typeof value === 'string' ? value : null;
};

/**
 * Converts a Wikidata entity (from wbgetentities) into the names and identifiers of a person.
 *
 * @param {any} entity
 * @returns {WikidataPerson}
 */
export function normalizePerson(entity) {
  const { claims } = entity;
  const languages = [...values(claims, 'P103'), ...values(claims, 'P1412')]
    .map((value) => LANGUAGE_CODES[value.id])
    .filter(Boolean);
  return {
    id: entity.id,
    labels: Object.fromEntries(
      Object.entries(entity.labels ?? {}).map(([language, label]) => [language, label.value]),
    ),
    aliases: Object.values(entity.aliases ?? {}).flatMap((list) => list.map((a) => a.value)),
    nativeNames: values(claims, 'P1559')
      .filter((value) => value.text)
      .map((value) => ({ text: value.text, language: value.language })),
    kanaReadings: values(claims, 'P1814').filter((value) => typeof value === 'string'),
    languages: [...new Set(languages)],
    countryLanguages: [
      ...new Set(values(claims, 'P27').map((value) => COUNTRY_LANGUAGES[value.id])),
    ].filter(Boolean),
    orcid: values(claims, 'P496')[0] ?? null,
    viaf: values(claims, 'P214')[0] ?? null,
  };
}

/**
 * The authors a work's entity credits, in order (those without an ordinal last).
 *
 * @param {any} entity
 * @returns {WikidataCredit[]}
 */
export function normalizeCredits(entity) {
  return (entity.claims?.P50 ?? [])
    .filter((claim) => claim.mainsnak?.datavalue?.value?.id)
    .map((claim) => {
      const ordinal = Number.parseInt(qualifier(claim, 'P1545'), 10);
      return {
        id: claim.mainsnak.datavalue.value.id,
        ordinal: Number.isFinite(ordinal) ? ordinal : null,
        statedAs: qualifier(claim, 'P1932'),
      };
    })
    .sort((a, b) => (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity));
}

/**
 * Creates the Wikidata adapter. It finds a work's item by DOI and a person's by ORCID, and
 * reads authors' names in other scripts and their identifiers. Wikidata is CC0.
 *
 * Wikimedia asks every client to identify itself with a contact address in its User-Agent and
 * throttles those that don't, so `contact` (an email or URL) should be set. Requests are
 * limited to `concurrency` at once; 429 and 5xx responses are retried after the wait the
 * server asks for, and failed connections after a backoff.
 *
 * @param {object} [options]
 * @param {string} [options.contact]
 * @param {string} [options.baseUrl]
 * @param {typeof fetch} [options.fetch]  Injected for tests.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected for tests.
 * @param {number} [options.concurrency]
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryBaseMs]
 * @param {number} [options.timeoutMs]
 */
export function createWikidataProvider({
  contact,
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  concurrency = 2,
  maxRetries = 3,
  retryBaseMs = 1000,
  timeoutMs = 10_000,
} = {}) {
  const userAgent = `Tracer/1.0 (citation graphs${contact ? `; ${contact}` : ''})`;
  let running = 0;
  const waiting = [];

  /** Runs `task` once fewer than `concurrency` requests are in flight. */
  async function limited(task) {
    // A finished request hands its slot straight to the next one waiting.
    if (running >= concurrency) await new Promise((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }

  /** @returns {Promise<any>}  The API's JSON response. */
  async function request(params) {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries({ ...params, format: 'json' })) {
      url.searchParams.set(key, value);
    }
    return limited(async () => {
      for (let attempt = 0; ; attempt++) {
        let response;
        try {
          response = await fetchImpl(url, {
            headers: { Accept: 'application/json', 'User-Agent': userAgent },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          // A dropped or timed-out connection is usually brief.
          if (attempt < maxRetries) {
            await sleep(retryBaseMs * 2 ** attempt);
            continue;
          }
          throw new ProviderError(NAME, `${params.action} request failed`, { cause });
        }
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(retryAfter > 0 ? retryAfter * 1000 : retryBaseMs * 2 ** attempt);
          continue;
        }
        if (!response.ok) {
          throw new ProviderError(NAME, `${params.action} returned ${response.status}`, {
            status: response.status,
          });
        }
        const body = await response.json().catch(() => null);
        if (!body || body.error) {
          throw new ProviderError(NAME, body?.error?.info ?? 'unexpected response');
        }
        return body;
      }
    });
  }

  /** The first item with `property` = `value`, or null. */
  async function findItem(property, value) {
    const body = await request({
      action: 'query',
      list: 'search',
      srsearch: `haswbstatement:${property}=${value}`,
      srnamespace: '0',
      srlimit: '1',
    });
    return body.query?.search?.[0]?.title ?? null;
  }

  /** Entities by ID, 50 at a time. */
  async function getEntities(ids, props) {
    const entities = [];
    for (let i = 0; i < ids.length; i += MAX_IDS) {
      const body = await request({
        action: 'wbgetentities',
        ids: ids.slice(i, i + MAX_IDS).join('|'),
        props,
      });
      entities.push(...Object.values(body.entities ?? {}).filter((entity) => !entity.missing));
    }
    return entities;
  }

  return {
    name: NAME,

    /**
     * The item of the work with this DOI, or null. Wikidata stores DOIs in upper case.
     *
     * @param {string} doi
     * @returns {Promise<string | null>}
     */
    async findByDoi(doi) {
      const normalized = normalizeDoi(doi);
      if (!normalized) throw new ProviderError(NAME, `not a DOI: ${doi}`);
      return findItem('P356', normalized.toUpperCase());
    },

    /**
     * The item of the person with this ORCID iD, or null.
     *
     * @param {string} orcid  Bare, e.g. "0000-0003-1613-5981".
     * @returns {Promise<string | null>}
     */
    async findByOrcid(orcid) {
      if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(orcid)) {
        throw new ProviderError(NAME, `not an ORCID iD: ${orcid}`);
      }
      return findItem('P496', orcid);
    },

    /**
     * The authors a work's item credits, in order.
     *
     * @param {string} itemId
     * @returns {Promise<WikidataCredit[]>}
     */
    async getWorkCredits(itemId) {
      const [entity] = await getEntities([itemId], 'claims');
      return entity ? normalizeCredits(entity) : [];
    },

    /**
     * People's names and identifiers.
     *
     * @param {string[]} ids
     * @returns {Promise<WikidataPerson[]>}
     */
    async getPeople(ids) {
      if (ids.length === 0) return [];
      return (await getEntities(ids, 'labels|aliases|claims')).map(normalizePerson);
    },
  };
}

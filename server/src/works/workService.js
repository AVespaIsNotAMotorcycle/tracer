import { CacheEntry } from '../models/CacheEntry.js';
import { Source } from '../models/Source.js';
import { normalizeDoi } from '../providers/ids.js';
import { toOpenAlexId } from '../providers/openalex.js';
import { HttpError } from './errors.js';

/** @typedef {import('../providers/types.js').Provider} Provider */
/** @typedef {import('../providers/types.js').ProviderWork} ProviderWork */

const DAY_MS = 24 * 60 * 60 * 1000;
const TRACER_ID_PATTERN = /^[0-9a-f]{24}$/i;

export const DEFAULT_TTLS = {
  work: 30 * DAY_MS,
  citing: 7 * DAY_MS,
  search: 1 * DAY_MS,
};

/**
 * A work as the client sees it. IDs are Tracer IDs; provider IDs only appear in externalIds.
 *
 * @typedef {object} Work
 * @property {string} id                 Tracer ID.
 * @property {Record<string, string>} externalIds
 * @property {string | null} title
 * @property {{ name: string, orcid: string | null }[]} authors
 * @property {number | null} year
 * @property {string | null} type
 * @property {string | null} venue
 * @property {string | null} abstract
 * @property {number | null} citedByCount
 * @property {string[]} references       Tracer IDs of the works this one cites.
 * @property {{ kind: string, url: string }[]} links
 * @property {string[]} providers        Providers that contributed data.
 */

const unique = (values) => [...new Set(values)];

/**
 * Looks up works through a provider, caching results in MongoDB and assigning Tracer IDs.
 *
 * Only OpenAlex is wired in today, so records are keyed by `provider.name` and the provider's
 * IDs are stored as externalIds.openalex. When a second provider is added, toWork() is where
 * records get merged.
 *
 * @param {object} options
 * @param {Provider} options.provider
 * @param {Partial<typeof DEFAULT_TTLS>} [options.ttls]
 * @param {() => Date} [options.now]  Injected for tests.
 */
export function createWorkService({ provider, ttls = {}, now = () => new Date() }) {
  const ttl = { ...DEFAULT_TTLS, ...ttls };
  const providerName = provider.name;
  const idField = `externalIds.${providerName}`;
  const recordField = `records.${providerName}`;

  const recordOf = (source) => source?.records?.[providerName];
  const isFresh = (source) => {
    const record = recordOf(source);
    return Boolean(record) && now() - record.fetchedAt < ttl.work;
  };

  /**
   * Stores provider works on their Sources, creating Sources as needed, and creates stub
   * Sources for every work they reference.
   *
   * @param {ProviderWork[]} works
   */
  async function saveWorks(works) {
    if (works.length === 0) return;
    const fetchedAt = now();

    const workOps = works.map((work) => {
      const set = { [recordField]: { data: work, fetchedAt } };
      for (const [key, value] of Object.entries(work.externalIds)) {
        set[`externalIds.${key}`] = key === 'doi' ? normalizeDoi(value) : value;
      }
      return {
        updateOne: {
          filter: { [idField]: work.providerId },
          update: { $set: set, $setOnInsert: { createdAt: fetchedAt } },
          upsert: true,
        },
      };
    });
    await Source.bulkWrite(workOps, { ordered: false });

    const workIds = new Set(works.map((work) => work.providerId));
    const referencedIds = unique(works.flatMap((work) => work.referencedIds)).filter(
      (id) => !workIds.has(id),
    );
    if (referencedIds.length > 0) {
      await Source.bulkWrite(
        referencedIds.map((id) => ({
          updateOne: {
            filter: { [idField]: id },
            update: { $setOnInsert: { createdAt: fetchedAt } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
  }

  /**
   * Converts Sources with provider data into client-facing Works, translating references to
   * Tracer IDs.
   */
  async function toWorks(sources) {
    const referencedIds = unique(sources.flatMap((s) => recordOf(s).data.referencedIds));
    const referenced = await Source.find({ [idField]: { $in: referencedIds } }, { [idField]: 1 })
      .lean()
      .exec();
    const tracerIdByProviderId = new Map(
      referenced.map((s) => [s.externalIds[providerName], String(s._id)]),
    );

    return sources.map((source) => {
      const { data } = recordOf(source);
      return {
        id: String(source._id),
        externalIds: Object.fromEntries(
          Object.entries(source.externalIds ?? {}).filter(([, value]) => value != null),
        ),
        title: data.title,
        authors: data.authors,
        year: data.year,
        type: data.type,
        venue: data.venue,
        abstract: data.abstract,
        citedByCount: data.citedByCount,
        references: data.referencedIds.map((id) => tracerIdByProviderId.get(id)).filter(Boolean),
        links: data.links,
        providers: Object.keys(source.records ?? {}),
      };
    });
  }

  /** Finds the Source an API path parameter refers to: a Tracer ID, provider ID, or DOI. */
  async function findSource(id) {
    if (TRACER_ID_PATTERN.test(id)) {
      return Source.findById(id).lean().exec();
    }
    const providerId = toOpenAlexId(id);
    if (providerId)
      return Source.findOne({ [idField]: providerId })
        .lean()
        .exec();
    const doi = normalizeDoi(id);
    if (doi) return Source.findOne({ 'externalIds.doi': doi }).lean().exec();
    throw new HttpError(400, `Unrecognized work ID: ${id}`);
  }

  /**
   * Returns the Source for `id` with fresh provider data, fetching it if needed.
   * Throws 404 if neither the database nor the provider knows the work.
   */
  async function loadSource(id) {
    const source = await findSource(id);
    if (isFresh(source)) return source;

    // Fetch by the stored provider ID if there is one. An unknown Tracer ID can't be fetched.
    const lookupKey = source
      ? source.externalIds?.[providerName]
      : TRACER_ID_PATTERN.test(id)
        ? null
        : id;
    const work = lookupKey && (await provider.getWork(lookupKey));
    if (!work) {
      if (recordOf(source)) return source; // Stale data beats none.
      throw new HttpError(404, `Work not found: ${id}`);
    }
    await saveWorks([work]);
    return Source.findOne({ [idField]: work.providerId })
      .lean()
      .exec();
  }

  /**
   * Returns Works for the given provider IDs in the same order, fetching any that have no
   * fresh data in one batch. IDs the provider doesn't know are dropped.
   */
  async function worksForProviderIds(providerIds) {
    let sources = await Source.find({ [idField]: { $in: providerIds } })
      .lean()
      .exec();
    const fresh = new Set(sources.filter(isFresh).map((s) => s.externalIds[providerName]));
    const missing = providerIds.filter((id) => !fresh.has(id));
    if (missing.length > 0) {
      await saveWorks(await provider.getWorks(missing));
      sources = await Source.find({ [idField]: { $in: providerIds } })
        .lean()
        .exec();
    }

    const byProviderId = new Map(sources.map((s) => [s.externalIds[providerName], s]));
    const ordered = providerIds.map((id) => byProviderId.get(id)).filter((s) => recordOf(s));
    return toWorks(ordered);
  }

  /** Returns cached provider IDs for `key`, or runs `fetchWorks`, saves, and caches them. */
  async function cachedList(key, ttlMs, fetchWorks) {
    const entry = await CacheEntry.findOne({ key, expiresAt: { $gt: now() } })
      .lean()
      .exec();
    if (entry) return worksForProviderIds(entry.providerIds);

    const works = await fetchWorks();
    await saveWorks(works);
    await CacheEntry.updateOne(
      { key },
      {
        $set: {
          providerIds: works.map((work) => work.providerId),
          expiresAt: new Date(now().getTime() + ttlMs),
        },
      },
      { upsert: true },
    );
    return worksForProviderIds(works.map((work) => work.providerId));
  }

  return {
    /** @returns {Promise<Work>} */
    async getWork(id) {
      const [work] = await toWorks([await loadSource(id)]);
      return work;
    },

    /** Works that cite `id`, most-cited first. @returns {Promise<Work[]>} */
    async getCitingWorks(id, { limit }) {
      // Citing lists only need the provider ID, so skip fetching the work if it's known.
      const source = (await findSource(id)) ?? (await loadSource(id));
      const providerId = source.externalIds?.[providerName];
      if (!providerId) throw new HttpError(404, `Work not found: ${id}`);
      return cachedList(`${providerName}:citing:${providerId}:${limit}`, ttl.citing, () =>
        provider.getCitingWorks(providerId, { limit }),
      );
    },

    /** Works `id` cites, in the provider's reference order. @returns {Promise<Work[]>} */
    async getCitedWorks(id, { limit }) {
      // The work's own record lists its references, so no list cache is needed.
      const source = await loadSource(id);
      return worksForProviderIds(recordOf(source).data.referencedIds.slice(0, limit));
    },

    /** @returns {Promise<Work[]>} */
    async searchWorks(query, { limit }) {
      const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
      return cachedList(`${providerName}:search:${limit}:${normalized}`, ttl.search, () =>
        provider.searchWorks(normalized, { limit }),
      );
    },
  };
}

import { CacheEntry } from '../models/CacheEntry.js';
import { Source } from '../models/Source.js';
import { normalizeDoi } from '../providers/ids.js';
import { toOpenAlexId } from '../providers/openalex.js';
import { matchArchiveItems, searchWords } from './archiveMatch.js';
import { HttpError } from './errors.js';

/** @typedef {import('../providers/types.js').Provider} Provider */
/** @typedef {import('../providers/types.js').ProviderWork} ProviderWork */
/** @typedef {import('../providers/types.js').ProviderReference} ProviderReference */

/** Work type of a reference-only work: known only from a reference list (see Source.js). */
export const REFERENCE_ONLY = 'reference-only';

const DAY_MS = 24 * 60 * 60 * 1000;
// Most citation links checked per work and direction from the link provider. Each 100 costs
// about one OpenAlex list request, and a classic can have thousands.
const MAX_LINKS = 300;
const TRACER_ID_PATTERN = /^[0-9a-f]{24}$/i;

export const DEFAULT_TTLS = {
  work: 30 * DAY_MS,
  citing: 7 * DAY_MS,
  search: 1 * DAY_MS,
  references: 30 * DAY_MS,
  archive: 30 * DAY_MS,
};
// Most Internet Archive items returned per work (editions and copies of a book).
const MAX_ARCHIVE_ITEMS = 5;

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

/** Lowercase letters and digits only, so formatting differences don't matter. */
const squash = (text) =>
  (text ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Swallows duplicate-key errors from a bulk insert or upsert: another request created the same
 * Source first, which is fine. Rethrows anything else.
 */
function ignoreDuplicates(err) {
  const errors = err.writeErrors ?? (err.code != null ? [err] : null);
  if (!errors?.length || !errors.every((e) => (e.code ?? e.err?.code) === 11000)) throw err;
}

/**
 * A key identifying the work a reference names, so references to the same work from different
 * reference lists share one Source: its DOI; else first author, year and title; else the
 * printed citation. Null when the reference has none of these.
 *
 * @param {ProviderReference} reference
 */
export function citationKey(reference) {
  if (reference.doi) return `d:${reference.doi}`;
  if (reference.title) {
    const author = squash(reference.authors[0]?.name);
    return `t:${author}|${reference.year ?? ''}|${squash(reference.title).slice(0, 120)}`;
  }
  if (reference.unstructured) return `u:${squash(reference.unstructured).slice(0, 200)}`;
  return null;
}

/**
 * Looks up works through a provider, caching results in MongoDB and assigning Tracer IDs.
 *
 * With a `referenceProvider` (Crossref), a work's cited works also include the references its
 * publisher deposited that the provider couldn't match: those with a DOI the provider has
 * become ordinary works, and the rest become reference-only works (see Source.js).
 *
 * With a `linkProvider` (OpenCitations), citing and cited works also include works linked
 * there that the provider has but doesn't link (see linkedExtras).
 *
 * Only OpenAlex is wired in today, so records are keyed by `provider.name` and the provider's
 * IDs are stored as externalIds.openalex. When a second provider is added, toWork() is where
 * records get merged.
 *
 * @param {object} options
 * @param {Provider} options.provider
 * @param {ReturnType<typeof import('../providers/crossref.js').createCrossrefProvider>} [options.referenceProvider]
 * @param {ReturnType<typeof import('../providers/opencitations.js').createOpenCitationsProvider>} [options.linkProvider]
 * @param {ReturnType<typeof import('../providers/internetarchive.js').createInternetArchiveProvider>} [options.archiveProvider]
 * @param {Partial<typeof DEFAULT_TTLS>} [options.ttls]
 * @param {() => Date} [options.now]  Injected for tests.
 */
export function createWorkService({
  provider,
  referenceProvider,
  linkProvider,
  archiveProvider,
  ttls = {},
  now = () => new Date(),
}) {
  const ttl = { ...DEFAULT_TTLS, ...ttls };
  const providerName = provider.name;
  const idField = `externalIds.${providerName}`;
  const recordField = `records.${providerName}`;

  const recordOf = (source) => source?.records?.[providerName];
  const referencesField = referenceProvider && `records.${referenceProvider.name}`;
  const referencesOf = (source) =>
    referenceProvider ? source?.records?.[referenceProvider.name] : null;
  const isReferenceOnly = (source) => Boolean(source?.citation) && !recordOf(source);
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

    // Stubs for referenced works, so every reference has a Tracer ID. A batch of works can
    // reference tens of thousands, and one upsert each is slow (about 5 ms apiece), so find
    // the ones that exist with one query and insert the rest together.
    const workIds = new Set(works.map((work) => work.providerId));
    const referencedIds = unique(works.flatMap((work) => work.referencedIds)).filter(
      (id) => !workIds.has(id),
    );
    if (referencedIds.length > 0) {
      const existing = await Source.find({ [idField]: { $in: referencedIds } }, { [idField]: 1 })
        .lean()
        .exec();
      const known = new Set(existing.map((s) => s.externalIds[providerName]));
      const missing = referencedIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        await Source.insertMany(
          missing.map((id) => ({ externalIds: { [providerName]: id }, createdAt: fetchedAt })),
          { ordered: false },
        ).catch(ignoreDuplicates);
      }
    }
  }

  /**
   * Converts Sources with provider data into client-facing Works, translating references to
   * Tracer IDs.
   */
  async function toWorks(sources) {
    const listed = sources.filter((s) => recordOf(s));
    const referencedIds = unique(listed.flatMap((s) => recordOf(s).data.referencedIds));
    const referenced = await Source.find({ [idField]: { $in: referencedIds } }, { [idField]: 1 })
      .lean()
      .exec();
    const tracerIdByProviderId = new Map(
      referenced.map((s) => [s.externalIds[providerName], String(s._id)]),
    );

    return sources.map((source) => {
      const externalIds = Object.fromEntries(
        Object.entries(source.externalIds ?? {}).filter(
          ([key, value]) => value != null && key !== 'citation',
        ),
      );
      if (isReferenceOnly(source)) {
        const { citation } = source;
        return {
          id: String(source._id),
          externalIds,
          title: citation.title ?? citation.unstructured ?? citation.doi,
          authors: citation.authors,
          year: citation.year,
          type: REFERENCE_ONLY,
          venue: citation.venue,
          abstract: null,
          citedByCount: null,
          references: [],
          links: citation.doi ? [{ kind: 'doi', url: `https://doi.org/${citation.doi}` }] : [],
          providers: [referenceProvider?.name ?? 'crossref'],
          citation: citation.unstructured,
        };
      }
      const { data } = recordOf(source);
      // Citations found elsewhere (Crossref reference lists, OpenCitations links) are stored
      // as Tracer IDs on records other than the provider's.
      const fromReferenceList = Object.entries(source.records ?? {})
        .filter(([name]) => name !== providerName)
        .flatMap(([, record]) => record?.data?.tracerIds ?? []);
      return {
        id: String(source._id),
        externalIds,
        title: data.title,
        authors: data.authors,
        year: data.year,
        type: data.type,
        venue: data.venue,
        abstract: data.abstract,
        citedByCount: data.citedByCount,
        references: unique([
          ...data.referencedIds.map((id) => tracerIdByProviderId.get(id)).filter(Boolean),
          ...fromReferenceList,
        ]),
        links: data.links,
        // The Archive lookup is stored as a record too, but none of the work's data is from it.
        providers: Object.keys(source.records ?? {}).filter(
          (name) => name !== archiveProvider?.name,
        ),
      };
    });
  }

  /**
   * Resolves the reference list deposited for `source` (by its DOI) to Tracer IDs, caching the
   * result on the source. References with a DOI the provider has become ordinary Sources;
   * the rest become reference-only Sources. Returns { tracerIds, referenceOnly } in deposit
   * order, or null when there's no reference provider or DOI. A failed lookup is logged and
   * falls back to the cached result, if any: the provider's own references still work.
   */
  async function resolveReferences(source) {
    const doi = source.externalIds?.doi;
    if (!referenceProvider || !doi) return null;
    const cached = referencesOf(source);
    if (cached && now() - cached.fetchedAt < ttl.references) return cached.data;

    let references;
    try {
      references = (await referenceProvider.getReferences(doi)) ?? [];
    } catch (err) {
      console.error(err);
      return cached?.data ?? null;
    }

    // References with a DOI: ordinary works if the provider has them.
    const dois = unique(references.map((r) => r.doi).filter(Boolean));
    const findByDoi = () =>
      Source.find({ 'externalIds.doi': { $in: dois }, [idField]: { $type: 'string' } })
        .lean()
        .exec();
    let known = dois.length ? await findByDoi() : [];
    const unknown = dois.filter((d) => !known.some((s) => s.externalIds.doi === d));
    if (unknown.length && provider.getWorksByDoi) {
      await saveWorks(await provider.getWorksByDoi(unknown));
      known = await findByDoi();
    }
    const tracerIdByDoi = new Map();
    for (const s of known)
      if (!tracerIdByDoi.has(s.externalIds.doi))
        tracerIdByDoi.set(s.externalIds.doi, String(s._id));

    // Everything else: reference-only works, keyed so repeat references share one.
    const unmatched = new Map();
    for (const reference of references) {
      if (reference.doi && tracerIdByDoi.has(reference.doi)) continue;
      const key = citationKey(reference);
      if (key && !unmatched.has(key)) unmatched.set(key, reference);
    }
    if (unmatched.size) {
      await Source.bulkWrite(
        [...unmatched].map(([key, reference]) => ({
          updateOne: {
            filter: { 'externalIds.citation': key },
            update: { $set: { citation: reference }, $setOnInsert: { createdAt: now() } },
            upsert: true,
          },
        })),
        { ordered: false },
      ).catch(ignoreDuplicates);
    }
    const keys = [...unmatched.keys()];
    const created = keys.length
      ? await Source.find({ 'externalIds.citation': { $in: keys } }, { externalIds: 1 })
          .lean()
          .exec()
      : [];
    const tracerIdByKey = new Map(created.map((s) => [s.externalIds.citation, String(s._id)]));

    const tracerIds = [];
    const referenceOnly = [];
    for (const reference of references) {
      const byDoi = reference.doi && tracerIdByDoi.get(reference.doi);
      const id = byDoi ?? tracerIdByKey.get(citationKey(reference));
      if (!id || tracerIds.includes(id) || id === String(source._id)) continue;
      tracerIds.push(id);
      if (!byDoi) referenceOnly.push(id);
    }
    const data = { tracerIds, referenceOnly };
    await Source.updateOne(
      { _id: source._id },
      { $set: { [referencesField]: { data, fetchedAt: now() } } },
    );
    return data;
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
    if (isFresh(source) || isReferenceOnly(source)) return source;

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
    return toWorks(await freshSources(providerIds));
  }

  /**
   * Sources with fresh provider data for the given provider IDs, in the same order, fetching
   * any that need it in one batch. IDs the provider doesn't know are dropped.
   */
  async function freshSources(providerIds) {
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
    return providerIds.map((id) => byProviderId.get(id)).filter((s) => recordOf(s));
  }

  /**
   * Provider IDs of works the link provider says `source` cites (direction 'cited') or that
   * cite it ('citing'), which the provider has but doesn't link to it. Checks at most
   * MAX_LINKS links, caches the result for the list TTL, and stores each link found on the
   * citing work's Source (records.<link provider>.data.tracerIds), so its edge draws wherever
   * that work appears. A failed lookup is logged and finds nothing.
   *
   * @param {object} source  A Source with provider data.
   * @param {'citing' | 'cited'} direction
   * @returns {Promise<string[]>}
   */
  async function linkedExtras(source, direction) {
    const doi = source.externalIds?.doi;
    const selfId = source.externalIds?.[providerName];
    if (!linkProvider || !doi || !selfId) return [];
    const key = `${linkProvider.name}:${direction}:${doi}`;
    const entry = await CacheEntry.findOne({ key, expiresAt: { $gt: now() } })
      .lean()
      .exec();
    if (entry) return entry.providerIds;

    let links;
    try {
      links = await (direction === 'citing'
        ? linkProvider.getCitingIds(doi)
        : linkProvider.getCitedIds(doi));
    } catch (err) {
      console.error(err);
      return [];
    }
    links = links.slice(0, MAX_LINKS);
    const byId = unique(links.map((link) => link.openalex).filter(Boolean));
    const byDoi = unique(links.filter((link) => !link.openalex && link.doi).map((l) => l.doi));
    const found = byDoi.length && provider.getWorksByDoi ? await provider.getWorksByDoi(byDoi) : [];
    await saveWorks(found);
    const candidates = await freshSources(
      unique([...byId, ...found.map((work) => work.providerId)]).filter((id) => id !== selfId),
    );
    const cites = (citing, cited) =>
      recordOf(citing).data.referencedIds.includes(cited.externalIds[providerName]);
    const extras = candidates.filter((other) =>
      direction === 'citing' ? !cites(other, source) : !cites(source, other),
    );

    const field = `records.${linkProvider.name}`;
    const addLinks = (citingId, citedIds) =>
      Source.updateOne(
        { _id: citingId },
        {
          $addToSet: { [`${field}.data.tracerIds`]: { $each: citedIds } },
          $set: { [`${field}.fetchedAt`]: now() },
        },
      );
    if (direction === 'citing') {
      await Promise.all(extras.map((other) => addLinks(other._id, [String(source._id)])));
    } else if (extras.length) {
      await addLinks(
        source._id,
        extras.map((other) => String(other._id)),
      );
    }

    const providerIds = extras.map((other) => other.externalIds[providerName]);
    await CacheEntry.updateOne(
      { key },
      {
        $set: {
          providerIds,
          expiresAt: new Date(
            now().getTime() + (direction === 'citing' ? ttl.citing : ttl.references),
          ),
        },
      },
      { upsert: true },
    );
    return providerIds;
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

    /**
     * Copies of `id` on the Internet Archive (editions of a book, usually), best first: found
     * by title and author (matchArchiveItems), and cached on its Source. A failed lookup is
     * logged and gives the cached items, if any, or none: they're extra links, not worth an
     * error.
     *
     * @returns {Promise<import('../providers/internetarchive.js').ArchiveItem[]>}
     */
    async getArchiveItems(id) {
      if (!archiveProvider) return [];
      const source = await loadSource(id);
      const field = `records.${archiveProvider.name}`;
      const cached = source.records?.[archiveProvider.name];
      if (cached && now() - cached.fetchedAt < ttl.archive) return cached.data.items;
      // A reference deposited only as printed text has no title of its own to search for
      // (its "title" is the whole citation), so it couldn't match.
      if (isReferenceOnly(source) && !source.citation.title) return [];
      const [work] = await toWorks([source]);
      const words = searchWords(work.title);
      if (words.length === 0) return [];
      let items;
      try {
        items = matchArchiveItems(work, await archiveProvider.searchTexts(words)).slice(
          0,
          MAX_ARCHIVE_ITEMS,
        );
      } catch (err) {
        console.error(err);
        return cached?.data.items ?? [];
      }
      await Source.updateOne(
        { _id: source._id },
        { $set: { [field]: { data: { items }, fetchedAt: now() } } },
      );
      return items;
    },

    /** Works that cite `id`, most-cited first. @returns {Promise<Work[]>} */
    async getCitingWorks(id, { limit }) {
      // Citing lists only need the provider ID, so skip fetching the work if it's known.
      const source = (await findSource(id)) ?? (await loadSource(id));
      // Nothing indexes what cites a reference-only work; edges to it come from the citing
      // works' own references.
      if (isReferenceOnly(source)) return [];
      const providerId = source.externalIds?.[providerName];
      if (!providerId) throw new HttpError(404, `Work not found: ${id}`);
      const listed = cachedList(`${providerName}:citing:${providerId}:${limit}`, ttl.citing, () =>
        provider.getCitingWorks(providerId, { limit }),
      );
      // Links need the work's DOI, which a stub doesn't have yet (single lookups are free).
      const linked = linkProvider
        ? (recordOf(source) ? Promise.resolve(source) : loadSource(id)).then((s) =>
            linkedExtras(s, 'citing'),
          )
        : Promise.resolve([]);
      const [works, extras] = await Promise.all([listed, linked]);
      const seen = new Set(works.map((work) => work.externalIds[providerName]));
      const more = extras.filter((extra) => !seen.has(extra));
      if (more.length === 0) return works;
      // Most-cited first across both, so the limit means the same thing.
      return [...works, ...(await worksForProviderIds(more))]
        .sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0))
        .slice(0, limit);
    },

    /**
     * Works `id` cites: the provider's references in its order, then any more found through
     * the deposited reference list, up to `limit`; then up to `limit` reference-only works.
     * Reference-only works get their own allowance, so they show up even for works with many
     * matched references.
     *
     * @returns {Promise<Work[]>}
     */
    async getCitedWorks(id, { limit }) {
      const source = await loadSource(id);
      if (isReferenceOnly(source)) return [];
      // The work's own record lists its references, so no list cache is needed.
      const [works, resolved, linked] = await Promise.all([
        worksForProviderIds(recordOf(source).data.referencedIds.slice(0, limit)),
        resolveReferences(source),
        linkedExtras(source, 'cited'),
      ]);
      const linkedSources = linked.length
        ? await Source.find({ [idField]: { $in: linked } }, { _id: 1 })
            .lean()
            .exec()
        : [];

      const seen = new Set(works.map((work) => work.id));
      const referenceOnly = new Set(resolved?.referenceOnly ?? []);
      const more = unique([
        ...(resolved?.tracerIds ?? []),
        ...linkedSources.map((s) => String(s._id)),
      ])
        .filter((tracerId) => !seen.has(tracerId) && !referenceOnly.has(tracerId))
        .slice(0, Math.max(0, limit - works.length));
      const extra = [...more, ...[...referenceOnly].slice(0, limit)];
      if (extra.length === 0) return works;
      const sources = await Source.find({ _id: { $in: extra } })
        .lean()
        .exec();
      const byId = new Map(sources.map((s) => [String(s._id), s]));
      const ordered = extra
        .map((tracerId) => byId.get(tracerId))
        .filter((s) => recordOf(s) || isReferenceOnly(s));
      return [...works, ...(await toWorks(ordered))];
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

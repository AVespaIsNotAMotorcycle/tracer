import { CacheEntry } from '../models/CacheEntry.js';
import { Source } from '../models/Source.js';
import { normalizeDoi } from '../providers/ids.js';
import { toOpenAlexId } from '../providers/openalex.js';
import {
  matchArchiveItems,
  matchArchiveItemsInText,
  printedSearchWords,
  searchWords,
} from './archiveMatch.js';
import { citationQuery, doiLinks, matchCitation } from './citationMatch.js';
import { HttpError } from './errors.js';
import { matchAuthors, otherNames, personLinks } from './authorNames.js';
import { canonicalIdMap, mergeSources, sameWork } from './merges.js';
import { chooseLanguage, otherTitles } from './titles.js';
import { shortestPath } from './pathSearch.js';

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
  authorNames: 30 * DAY_MS,
  citationMatch: 30 * DAY_MS,
};
// The shape of stored provider data, as `version` on each record. A record stored by an
// earlier version lacks fields toWorks now reads, so it counts as expired and is fetched again
// when next needed. Bump it when ProviderWork or the Crossref record gains a field.
// 1 (no version): before language; 2: language, and Crossref's titles.
export const RECORD_VERSION = 2;
// Path searches (see findPath) stop starting new levels after this long, well inside Heroku's
// 30-second request limit; one level takes a few seconds at most.
const PATH_TIME_MS = 18_000;
export const PATH_MAX_STEPS = 8;
export const PATH_MAX_WORKS = 5000;
// Most authors per work looked up on Wikidata by ORCID iD (one request each).
const MAX_ORCID_LOOKUPS = 5;
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
 * @property {string | null} language  ISO 639 code: as OpenAlex detected it, or as deposited
 *   with Crossref where that's more plausible (see chooseLanguage).
 * @property {string | null} languageProvider  Which of those it came from.
 * @property {import('./titles.js').OtherTitle[]} otherTitles  Its original title, or its title
 *   in another script, where Crossref has one (see otherTitles).
 * @property {Record<string, string[]>} referenceProviders
 *   For each reference, the providers that have the citation: the provider's own reference
 *   list (openalex), a deposited reference list (crossref), or a citation index
 *   (opencitations). A citation several have lists them all.
 * @property {{ kind: string, url: string }[]} links
 * @property {string[]} providers        Providers that contributed data.
 * @property {string[]} mergedIds        Tracer IDs of duplicates merged into this work (see
 *   merges.js): the client treats them as this work.
 */

const unique = (values) => [...new Set(values)];

/** Works without repeats (two IDs merged into one work) or `selfId`, in order. */
function uniqueWorks(works, selfId) {
  const seen = new Set([selfId]);
  return works.filter((work) => !seen.has(work.id) && seen.add(work.id));
}

/**
 * Whether a work has anything to build a graph from: works citing it, or references (its
 * provider's, or found through Crossref or OpenCitations).
 */
const hasLinks = (work) => (work.citedByCount ?? 0) > 0 || work.references.length > 0;

const mostCitedFirst = (works) =>
  [...works].sort((a, b) => (b.citedByCount ?? 0) - (a.citedByCount ?? 0));

/** JSON with keys sorted, so equal objects give equal strings (for cache keys). */
const stableJson = (value) =>
  JSON.stringify(value, (key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

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
 * Duplicate Sources are merged (see merges.js): OpenAlex works sharing a DOI when they're
 * saved, and a reference-only work when Crossref matches it to a work the provider has. Every
 * lookup follows a merged Source to the one it was merged into, and a work's citations
 * include those of the Sources merged into it.
 *
 * @param {object} options
 * @param {Provider} options.provider
 * @param {ReturnType<typeof import('../providers/crossref.js').createCrossrefProvider>} [options.referenceProvider]
 * @param {ReturnType<typeof import('../providers/opencitations.js').createOpenCitationsProvider>} [options.linkProvider]
 * @param {ReturnType<typeof import('../providers/internetarchive.js').createInternetArchiveProvider>} [options.archiveProvider]
 * @param {ReturnType<typeof import('../providers/wikidata.js').createWikidataProvider>} [options.nameProvider]
 * @param {Partial<typeof DEFAULT_TTLS>} [options.ttls]
 * @param {() => Date} [options.now]  Injected for tests.
 */
export function createWorkService({
  provider,
  referenceProvider,
  linkProvider,
  archiveProvider,
  nameProvider,
  ttls = {},
  now = () => new Date(),
}) {
  const ttl = { ...DEFAULT_TTLS, ...ttls };
  const providerName = provider.name;
  const idField = `externalIds.${providerName}`;
  const recordField = `records.${providerName}`;

  const recordOf = (source) => source?.records?.[providerName];
  const referencesField = referenceProvider && `records.${referenceProvider.name}`;
  // The Crossref record: the deposited reference list resolved to Tracer IDs, and the work's
  // titles and language as deposited.
  const depositOf = (source) =>
    referenceProvider ? source?.records?.[referenceProvider.name] : null;
  const isReferenceOnly = (source) => Boolean(source?.citation) && !recordOf(source);
  const isCurrent = (record, ttlMs) =>
    Boolean(record) && (record.version ?? 1) >= RECORD_VERSION && now() - record.fetchedAt < ttlMs;
  const isFresh = (source) => isCurrent(recordOf(source), ttl.work);

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
      const set = { [recordField]: { data: work, fetchedAt, version: RECORD_VERSION } };
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
    await mergeDuplicates(works);
  }

  /**
   * Merges the provider's records that share a DOI with one of `works` and are the same work
   * (sameWork): OpenAlex sometimes has a work twice, its citations split between the records.
   * The most-cited record becomes the canonical one (the older Source on a tie).
   *
   * @param {ProviderWork[]} works
   */
  async function mergeDuplicates(works) {
    const dois = unique(works.map((work) => normalizeDoi(work.externalIds.doi)).filter(Boolean));
    if (dois.length === 0) return;
    const sources = await Source.find(
      {
        'externalIds.doi': { $in: dois },
        [recordField]: { $exists: true },
        mergedInto: { $exists: false },
      },
      { externalIds: 1, [recordField]: 1 },
    )
      .lean()
      .exec();
    const byDoi = Map.groupBy(sources, (s) => s.externalIds.doi);
    const count = (s) => recordOf(s).data.citedByCount ?? 0;
    for (const group of byDoi.values()) {
      if (group.length < 2) continue;
      const [canonical, ...others] = group.sort(
        (a, b) => count(b) - count(a) || String(a._id).localeCompare(String(b._id)),
      );
      for (const other of others) {
        if (sameWork(recordOf(canonical).data, recordOf(other).data)) {
          await mergeSources(other._id, canonical._id, 'doi', now());
        }
      }
    }
  }

  /** The Source `source` was merged into, if it was; otherwise `source` itself. */
  async function followMerged(source) {
    if (!source?.mergedInto) return source;
    const id = String(source._id);
    const canonical = (await canonicalIdMap([id])).get(id) ?? source.mergedInto;
    return (await Source.findById(canonical).lean().exec()) ?? source;
  }

  /**
   * `sources` with each merged one replaced by the Source it was merged into, in order, each
   * once. Missing ones (null) are dropped.
   */
  async function canonicalSources(sources) {
    const present = sources.filter(Boolean);
    const merged = present.filter((s) => s.mergedInto);
    const redirects = merged.length
      ? await canonicalIdMap(merged.map((s) => String(s._id)))
      : new Map();
    const targets = redirects.size
      ? await Source.find({ _id: { $in: unique([...redirects.values()]) } })
          .lean()
          .exec()
      : [];
    const byId = new Map(targets.map((s) => [String(s._id), s]));
    const seen = new Set();
    const result = [];
    for (const source of present) {
      const id = String(source._id);
      const canonical = redirects.has(id) ? byId.get(redirects.get(id)) : source;
      if (!canonical || seen.has(String(canonical._id))) continue;
      seen.add(String(canonical._id));
      result.push(canonical);
    }
    return result;
  }

  /** The Sources merged into each of `sources`, by Tracer ID. */
  async function mergedMembers(sources) {
    const ids = sources.map((s) => s._id);
    const members = ids.length
      ? await Source.find({ mergedInto: { $in: ids } })
          .lean()
          .exec()
      : [];
    return Map.groupBy(members, (s) => String(s.mergedInto));
  }

  /**
   * Converts Sources with provider data into client-facing Works, translating references to
   * Tracer IDs. A merged Source becomes the work it was merged into (once, where it first
   * appears), and a work's references and citation count include those of the Sources merged
   * into it, so its in-graph links and size count both records.
   */
  async function toWorks(input) {
    const sources = await canonicalSources(input);
    const listed = sources.filter((s) => recordOf(s));
    const membersById = await mergedMembers(listed);
    const withMembers = (s) => [s, ...(membersById.get(String(s._id)) ?? [])];
    const referencedIds = unique(
      listed.flatMap((s) => withMembers(s).flatMap((m) => recordOf(m)?.data.referencedIds ?? [])),
    );
    // A reference to a merged Source points to the Source it was merged into (redirects are
    // one hop; see mergeSources).
    const referenced = await Source.find(
      { [idField]: { $in: referencedIds } },
      { [idField]: 1, mergedInto: 1 },
    )
      .lean()
      .exec();
    const tracerIdByProviderId = new Map(
      referenced.map((s) => [s.externalIds[providerName], String(s.mergedInto ?? s._id)]),
    );
    // Citations found elsewhere (Crossref reference lists, OpenCitations links) are stored as
    // Tracer IDs on records other than the provider's.
    const foundElsewhere = (s) =>
      Object.entries(s.records ?? {})
        .filter(([name]) => name !== providerName)
        .flatMap(([name, record]) => (record?.data?.tracerIds ?? []).map((id) => [id, name]));
    const redirects = await canonicalIdMap(
      unique(
        listed.flatMap((source) =>
          withMembers(source).flatMap((s) => foundElsewhere(s).map(([id]) => id)),
        ),
      ),
    );
    // Each reference with the provider that has it, in order: [Tracer ID, provider name].
    const referencesOf = (source) =>
      withMembers(source).flatMap((s) => [
        ...(recordOf(s)?.data.referencedIds ?? [])
          .map((id) => tracerIdByProviderId.get(id))
          .filter(Boolean)
          .map((id) => [id, providerName]),
        ...foundElsewhere(s).map(([id, name]) => [redirects.get(id) ?? id, name]),
      ]);

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
          referenceProviders: {},
          language: null,
          languageProvider: null,
          otherTitles: [],
          links: citation.doi ? doiLinks(citation.doi) : [],
          providers: [referenceProvider?.name ?? 'crossref'],
          mergedIds: [],
          citation: citation.unstructured,
        };
      }
      const { data } = recordOf(source);
      const id = String(source._id);
      const deposited = depositOf(source)?.data;
      const language = chooseLanguage(data.title, data.language, deposited?.language);
      const all = withMembers(source);
      // Duplicates split a work's citations between them, so their counts add up.
      const counts = all.map((s) => recordOf(s)?.data.citedByCount).filter((n) => n != null);
      // Which providers have each citation, so the client can say where a link came from.
      const referenceProviders = {};
      for (const [ref, name] of referencesOf(source)) {
        if (ref === id) continue;
        referenceProviders[ref] ??= [];
        if (!referenceProviders[ref].includes(name)) referenceProviders[ref].push(name);
      }
      return {
        id,
        externalIds,
        title: data.title,
        authors: data.authors,
        year: data.year,
        type: data.type,
        venue: data.venue,
        abstract: data.abstract,
        citedByCount: counts.length ? counts.reduce((sum, n) => sum + n, 0) : null,
        references: Object.keys(referenceProviders),
        referenceProviders,
        language: language.language,
        languageProvider:
          language.from === 'deposited'
            ? referenceProvider.name
            : language.from === 'detected'
              ? providerName
              : null,
        otherTitles: otherTitles(data.title, deposited),
        links: data.links,
        // The Archive and Wikidata lookups are stored as records too, but they only add links
        // and authors' names, shown with their source.
        providers: unique(all.flatMap((s) => Object.keys(s.records ?? {}))).filter(
          (name) => name !== archiveProvider?.name && name !== nameProvider?.name,
        ),
        mergedIds: all.slice(1).map((s) => String(s._id)),
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
    const cached = depositOf(source);
    if (isCurrent(cached, ttl.references)) return cached.data;

    let references;
    let deposited = null;
    try {
      if (referenceProvider.getRecord) {
        deposited = await referenceProvider.getRecord(doi);
        references = deposited?.references ?? [];
      } else {
        references = (await referenceProvider.getReferences(doi)) ?? [];
      }
    } catch (err) {
      console.error(err);
      return cached?.data ?? null;
    }

    // References with a DOI: ordinary works if the provider has them.
    const dois = unique(references.map((r) => r.doi).filter(Boolean));
    const findByDoi = () =>
      Source.find({
        'externalIds.doi': { $in: dois },
        [idField]: { $type: 'string' },
        mergedInto: { $exists: false },
      })
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
    await mergeReferenceOnlyByDoi(known);

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
    const data = {
      tracerIds,
      referenceOnly,
      title: deposited?.title ?? null,
      originalTitle: deposited?.originalTitle ?? null,
      language: deposited?.language ?? null,
    };
    await Source.updateOne(
      { _id: source._id },
      { $set: { [referencesField]: { data, fetchedAt: now(), version: RECORD_VERSION } } },
    );
    return data;
  }

  /**
   * Merges reference-only works made for a DOI (keyed `d:<doi>`) before the provider had it
   * into `sources`, the provider's works with those DOIs, when the reference agrees with the
   * record (sameWork; a reference without a title can't disagree).
   */
  async function mergeReferenceOnlyByDoi(sources) {
    const byKey = new Map();
    for (const s of sources) {
      const key = `d:${s.externalIds.doi}`;
      if (!byKey.has(key)) byKey.set(key, s);
    }
    if (byKey.size === 0) return;
    const stale = await Source.find({
      'externalIds.citation': { $in: [...byKey.keys()] },
      mergedInto: { $exists: false },
    })
      .lean()
      .exec();
    for (const reference of stale) {
      const target = byKey.get(reference.externalIds.citation);
      if (
        isReferenceOnly(reference) &&
        sameWork(reference.citation, recordOf(target).data, { requireTitles: false })
      ) {
        await mergeSources(reference._id, target._id, 'doi', now());
      }
    }
  }

  /**
   * Finds the Source an API path parameter refers to: a Tracer ID, provider ID, or DOI. A
   * merged Source is followed to the one it was merged into, unless `follow` is false.
   */
  async function findSource(id, { follow = true } = {}) {
    let source;
    if (TRACER_ID_PATTERN.test(id)) {
      source = await Source.findById(id).lean().exec();
    } else if (toOpenAlexId(id)) {
      source = await Source.findOne({ [idField]: toOpenAlexId(id) })
        .lean()
        .exec();
    } else if (normalizeDoi(id)) {
      source = await Source.findOne({ 'externalIds.doi': normalizeDoi(id) })
        .lean()
        .exec();
    } else {
      throw new HttpError(400, `Unrecognized work ID: ${id}`);
    }
    return follow ? followMerged(source) : source;
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
    return followMerged(
      await Source.findOne({ [idField]: work.providerId })
        .lean()
        .exec(),
    );
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

  /**
   * Merges reference-only `source` into the work Crossref matched it to (`match`), if the
   * provider has that work (by DOI, fetching it if need be) and its record agrees with the
   * match (sameWork). Returns that work, or null. The lookup is recorded on the match
   * (`mergeChecked`), so a work the provider doesn't have isn't looked up again until the
   * match is refreshed. A failed lookup is logged and merges nothing.
   */
  async function mergeMatched(source, match) {
    const doi = normalizeDoi(match.doi);
    if (!doi) return null;
    const find = async () =>
      followMerged(
        await Source.findOne({ 'externalIds.doi': doi, [recordField]: { $exists: true } })
          .lean()
          .exec(),
      );
    let target;
    try {
      target = await find();
      if (!target && provider.getWorksByDoi) {
        await saveWorks(await provider.getWorksByDoi([doi]));
        target = await find();
      }
    } catch (err) {
      console.error(err);
      return null;
    }
    await Source.updateOne({ _id: source._id }, { $set: { 'citationMatch.mergeChecked': true } });
    if (!recordOf(target) || !sameWork(match, recordOf(target).data)) return null;
    await mergeSources(source._id, target._id, 'citation-match', now());
    const [work] = await toWorks([target]);
    return work;
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
     * by title and author (matchArchiveItems), or for a reference printed as text, by its
     * words (matchArchiveItemsInText), and cached on its Source. A failed lookup is
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
      // A reference deposited only as printed text has no title of its own (its "title" is the
      // whole citation), so it's searched by its words and matched against its text.
      const printed = isReferenceOnly(source) && !source.citation.title;
      const [work] = await toWorks([source]);
      const words = printed
        ? printedSearchWords(source.citation.unstructured)
        : searchWords(work.title);
      if (words.length < (printed ? 2 : 1)) return [];
      let items;
      try {
        const found = await archiveProvider.searchTexts(words, { anyField: printed });
        items = (
          printed
            ? matchArchiveItemsInText(source.citation.unstructured, source.citation.year, found)
            : matchArchiveItems(work, found)
        ).slice(0, MAX_ARCHIVE_ITEMS);
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

    /**
     * The work's authors as Wikidata knows them, for those it can be sure of (see
     * matchAuthors): each one's index in the work's `authors`, Wikidata item, their name in
     * other scripts (see otherNames) and links to Wikidata and VIAF. People come from the
     * work's Wikidata item, found by DOI, and from authors' ORCID iDs. Cached on its Source for
     * 30 days. A failed lookup is logged and gives the cached authors, if any, or none.
     * Reference-only works aren't looked up: their authors are only surnames.
     *
     * @returns {Promise<{ index: number, name: string, wikidata: string,
     *   otherNames: import('./authorNames.js').OtherName[], links: { kind: string,
     *   url: string }[] }[]>}
     */
    async getAuthorNames(id) {
      if (!nameProvider) return [];
      const source = await loadSource(id);
      if (isReferenceOnly(source)) return [];
      const field = `records.${nameProvider.name}`;
      const cached = source.records?.[nameProvider.name];
      if (isCurrent(cached, ttl.authorNames)) return cached.data.authors;
      const [work] = await toWorks([source]);
      if (work.authors.length === 0) return [];

      let authors;
      try {
        const doi = work.externalIds.doi;
        const item = doi ? await nameProvider.findByDoi(doi) : null;
        const credits = item ? await nameProvider.getWorkCredits(item) : [];
        // Authors with an ORCID iD the work's item may not credit.
        const byOrcid = await Promise.all(
          work.authors
            .filter((author) => author.orcid)
            .slice(0, MAX_ORCID_LOOKUPS)
            .map((author) => nameProvider.findByOrcid(author.orcid).catch(() => null)),
        );
        const ids = unique([...credits.map((credit) => credit.id), ...byOrcid.filter(Boolean)]);
        const people = await nameProvider.getPeople(ids);
        authors = [...matchAuthors(work.authors, credits, people)]
          .sort(([a], [b]) => a - b)
          .map(([index, person]) => ({
            index,
            name: work.authors[index].name,
            wikidata: person.id,
            otherNames: otherNames(work.authors[index].name, person),
            links: personLinks(person),
          }));
      } catch (err) {
        console.error(err);
        return cached?.data.authors ?? [];
      }
      await Source.updateOne(
        { _id: source._id },
        { $set: { [field]: { data: { authors }, fetchedAt: now(), version: RECORD_VERSION } } },
      );
      return authors;
    },

    /**
     * For a reference-only work, the work Crossref's citation search matched it to (see
     * matchCitation), with links to it (its DOI, and JSTOR for a JSTOR DOI): `{ match }`, with
     * a null match when there's none, or for any other work. Cached on its Source, misses too.
     * A failed search is logged and gives the cached match, if any: it's an extra, not worth an
     * error.
     *
     * When the provider has the matched work and it agrees (see mergeMatched), the
     * reference-only work is merged into it, and `work` is that work (its `mergedIds` include
     * `id`), so the client can replace the grey node with it.
     *
     * @returns {Promise<{ match: object | null, work?: Work }>}
     */
    async getCitationMatch(id) {
      if (!referenceProvider?.searchCitation) return { match: null };
      const source = (await findSource(id, { follow: false })) ?? (await loadSource(id));
      if (!isReferenceOnly(source) || source.citation.doi) return { match: null };
      const cached = source.citationMatch;
      const withLinks = (match) => (match ? { ...match, links: doiLinks(match.doi) } : null);
      if (source.mergedInto) {
        const [work] = await toWorks([source]);
        return { match: withLinks(cached?.data ?? null), work };
      }
      let match;
      let checked = false;
      if (cached?.fetchedAt && now() - cached.fetchedAt < ttl.citationMatch) {
        match = cached.data;
        checked = Boolean(cached.mergeChecked);
      } else {
        const query = citationQuery(source.citation);
        if (!query) return { match: null };
        try {
          match = matchCitation(source.citation, await referenceProvider.searchCitation(query));
        } catch (err) {
          console.error(err);
          return { match: withLinks(cached?.data ?? null) };
        }
        await Source.updateOne(
          { _id: source._id },
          { $set: { citationMatch: { data: match, fetchedAt: now() } } },
        );
      }
      const work = match && !checked ? await mergeMatched(source, match) : null;
      return work ? { match: withLinks(match), work } : { match: withLinks(match) };
    },

    /**
     * Works that cite `id`, most-cited first. A work with duplicates merged into it lists the
     * works citing any of them.
     *
     * @returns {Promise<Work[]>}
     */
    async getCitingWorks(id, { limit }) {
      // Citing lists only need the provider ID, so skip fetching the work if it's known.
      const source = (await findSource(id)) ?? (await loadSource(id));
      // Nothing indexes what cites a reference-only work; edges to it come from the citing
      // works' own references.
      if (isReferenceOnly(source)) return [];
      const providerId = source.externalIds?.[providerName];
      if (!providerId) throw new HttpError(404, `Work not found: ${id}`);
      const selfId = String(source._id);
      const members = await Source.find(
        { mergedInto: source._id, [idField]: { $type: 'string' } },
        { externalIds: 1 },
      )
        .lean()
        .exec();
      const providerIds = [providerId, ...members.map((m) => m.externalIds[providerName])];
      const listed = Promise.all(
        providerIds.map((pid) =>
          cachedList(`${providerName}:citing:${pid}:${limit}`, ttl.citing, () =>
            provider.getCitingWorks(pid, { limit }),
          ),
        ),
      ).then((lists) => uniqueWorks(lists.flat(), selfId));
      // Links need the work's DOI, which a stub doesn't have yet (single lookups are free).
      const linked = linkProvider
        ? (recordOf(source) ? Promise.resolve(source) : loadSource(id)).then((s) =>
            linkedExtras(s, 'citing'),
          )
        : Promise.resolve([]);
      const [works, extras] = await Promise.all([listed, linked]);
      const seen = new Set(works.map((work) => work.externalIds[providerName]));
      const more = extras.filter((extra) => !seen.has(extra));
      if (more.length === 0 && providerIds.length === 1) return works;
      // Most-cited first across all lists, so the limit means the same thing.
      const all = more.length ? [...works, ...(await worksForProviderIds(more))] : works;
      return mostCitedFirst(uniqueWorks(all, selfId)).slice(0, limit);
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
      const selfId = String(source._id);
      // A work's duplicates merged into it add their references.
      const members = (await mergedMembers([source])).get(selfId) ?? [];
      const referencedIds = unique(
        [source, ...members].flatMap((s) => recordOf(s)?.data.referencedIds ?? []),
      );
      // The work's own record lists its references, so no list cache is needed.
      const [works, resolved, linked] = await Promise.all([
        worksForProviderIds(referencedIds.slice(0, limit)),
        resolveReferences(source),
        linkedExtras(source, 'cited'),
      ]);
      const linkedSources = linked.length
        ? await Source.find({ [idField]: { $in: linked } }, { _id: 1 })
            .lean()
            .exec()
        : [];

      const seen = new Set([selfId, ...works.map((work) => work.id)]);
      // Reference-only works merged since the list was resolved are ordinary works now.
      const resolvedIds = resolved?.tracerIds ?? [];
      const redirects = await canonicalIdMap(resolvedIds);
      const referenceOnly = new Set(
        (resolved?.referenceOnly ?? []).filter((tracerId) => !redirects.has(tracerId)),
      );
      const more = unique([
        ...resolvedIds.map((tracerId) => redirects.get(tracerId) ?? tracerId),
        ...linkedSources.map((s) => String(s._id)),
      ])
        .filter((tracerId) => !seen.has(tracerId) && !referenceOnly.has(tracerId))
        .slice(0, Math.max(0, limit - works.length));
      const extra = [...more, ...[...referenceOnly].slice(0, limit)];
      if (extra.length === 0) return uniqueWorks(works, selfId);
      const sources = await Source.find({ _id: { $in: extra } })
        .lean()
        .exec();
      const byId = new Map(sources.map((s) => [String(s._id), s]));
      const ordered = extra
        .map((tracerId) => byId.get(tracerId))
        .filter((s) => recordOf(s) || isReferenceOnly(s));
      return uniqueWorks([...works, ...(await toWorks(ordered))], selfId);
    },

    /**
     * One page of works matching every field of `criteria` (see SearchCriteria), and how many
     * match in all. Cached like searches.
     *
     * @param {import('../providers/types.js').SearchCriteria} criteria
     * @returns {Promise<{ works: Work[], total: number }>}
     */
    async advancedSearch(criteria, { limit, page }) {
      if (!provider.searchWorksAdvanced) throw new HttpError(501, 'Advanced search unavailable');
      const key = `${providerName}:advanced:${limit}:${page}:${stableJson(criteria)}`;
      const entry = await CacheEntry.findOne({ key, expiresAt: { $gt: now() } })
        .lean()
        .exec();
      if (entry) {
        return { works: await worksForProviderIds(entry.providerIds), total: entry.total ?? 0 };
      }
      const { works, total } = await provider.searchWorksAdvanced(criteria, { limit, page });
      await saveWorks(works);
      const providerIds = works.map((work) => work.providerId);
      await CacheEntry.updateOne(
        { key },
        { $set: { providerIds, total, expiresAt: new Date(now().getTime() + ttl.search) } },
        { upsert: true },
      );
      return { works: await worksForProviderIds(providerIds), total };
    },

    /**
     * Venues ('venue') or publishers ('publisher') whose names match `query`, for narrowing
     * an advanced search. Not cached: the provider's autocomplete is free and fast.
     *
     * @returns {Promise<import('../providers/types.js').Suggestion[]>}
     */
    async suggest(kind, query) {
      if (!provider.suggest) return [];
      return provider.suggest(kind, query);
    },

    /**
     * The shortest chain of citations, either way, from `fromId` to the nearest of `toIds`
     * (see shortestPath), most-cited first among equally short ones, searched through the provider's links in
     * batches. Each step is a Work, with how the step before relates to it (`link`: 'cites' or
     * 'cited-by'). Works not on the provider have no links to search.
     *
     * @returns {Promise<{ path: { work: Work, link: string | null }[] | null, searched: number,
     *   outcome: 'found' | 'none' | 'budget', complete: boolean }>}
     */
    async findPath(fromId, toIds) {
      if (!provider.getNeighborIds) throw new HttpError(501, 'Path search unavailable');
      const [from, ...to] = await Promise.all([fromId, ...[toIds].flat()].map(loadSource));
      const fromKey = from.externalIds?.[providerName];
      // Reference-only works have no links to search.
      const toKeys = to
        .filter((source) => !isReferenceOnly(source))
        .map((source) => source.externalIds?.[providerName])
        .filter(Boolean);
      if (toKeys.includes(fromKey)) throw new HttpError(400, 'A path needs two different works');
      if (!fromKey || isReferenceOnly(from) || toKeys.length === 0) {
        return { path: null, searched: 0, outcome: 'none', complete: true };
      }
      const deadline = now().getTime() + PATH_TIME_MS;
      const result = await shortestPath(fromKey, toKeys, {
        neighbors: (ids) => provider.getNeighborIds(ids),
        citationCounts: (ids) => provider.getCitationCounts(ids),
        maxSteps: PATH_MAX_STEPS,
        maxWorks: PATH_MAX_WORKS,
        deadline,
        now: () => now().getTime(),
      });
      if (!result.path) return result;
      const works = await worksForProviderIds(result.path.map((step) => step.id));
      const byProviderId = new Map(works.map((work) => [work.externalIds[providerName], work]));
      const path = result.path.map((step) => ({
        work: byProviderId.get(step.id),
        link: step.link,
      }));
      if (path.some((step) => !step.work)) {
        throw new HttpError(502, 'A work on the path could not be loaded');
      }
      return { ...result, path };
    },

    /**
     * Works matching `query`, in the provider's relevance order, except that works with no
     * links (nothing cites them and they have no references) come last: built from, they'd be
     * a lone anchor. A search for "Cixi" otherwise starts with eight such short titles (and
     * articles about Cixi city) ahead of works with dozens of links.
     *
     * @returns {Promise<Work[]>}
     */
    async searchWorks(query, { limit }) {
      const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
      const works = await cachedList(
        `${providerName}:search:${limit}:${normalized}`,
        ttl.search,
        () => provider.searchWorks(normalized, { limit }),
      );
      return [...works.filter(hasLinks), ...works.filter((work) => !hasLinks(work))];
    },
  };
}

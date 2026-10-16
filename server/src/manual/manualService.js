import { ManualLink } from '../models/ManualLink.js';
import { MANUAL_WORK_TYPES, ManualWork } from '../models/ManualWork.js';
import { Source } from '../models/Source.js';
import { normalizeDoi } from '../providers/ids.js';
import { doiLinks } from '../works/citationMatch.js';
import { HttpError } from '../works/errors.js';
import { canonicalIdMap } from '../works/merges.js';

const TRACER_ID_PATTERN = /^[0-9a-f]{24}$/i;
// The most works and links one user can add by hand.
const MAX_WORKS = 5000;
const MAX_LINKS = 20_000;
const MAX_AUTHORS = 20;

const bad = (message) => new HttpError(400, message);

/** A ManualWork as the client sees works (see Work in workService.js), marked `manual`. */
export function manualWorkToWork(doc) {
  return {
    id: String(doc._id),
    externalIds: doc.doi ? { doi: doc.doi } : {},
    title: doc.title,
    authors: (doc.authors ?? []).map((name) => ({ name, orcid: null })),
    year: doc.year ?? null,
    type: doc.type ?? 'other',
    venue: doc.venue ?? null,
    abstract: null,
    citedByCount: null,
    references: [],
    referenceProviders: {},
    links: doc.doi ? doiLinks(doc.doi) : [],
    providers: ['manual'],
    manual: true,
    mergedIds: [],
    language: null,
    languageProvider: null,
    otherTitles: [],
    topic: null,
  };
}

/** The fields of a work added by hand, checked and trimmed. Throws 400 if any is invalid. */
function checkWork(fields) {
  const text = (value, name, max) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string') throw bad(`Invalid ${name}`);
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (trimmed.length > max) throw bad(`Use a ${name} of at most ${max} characters`);
    return trimmed || null;
  };
  const title = text(fields?.title, 'title', 500);
  if (!title) throw bad('Give the work a title');
  const authors = fields.authors ?? [];
  if (!Array.isArray(authors) || authors.length > MAX_AUTHORS) throw bad('Invalid authors');
  const year = fields.year ?? null;
  if (year != null && (!Number.isInteger(year) || year < -5000 || year > 3000)) {
    throw bad('Invalid year');
  }
  const type = fields.type ?? 'other';
  if (!MANUAL_WORK_TYPES.includes(type)) throw bad('Invalid type');
  const doi = fields.doi ? normalizeDoi(fields.doi) : null;
  if (fields.doi && !doi) throw bad('Invalid DOI');
  return {
    title,
    authors: authors.map((name) => text(name, 'author', 200)).filter(Boolean),
    year,
    type,
    venue: text(fields.venue, 'venue', 300),
    doi,
  };
}

/**
 * The works and citations a user added by hand (see ManualWork and ManualLink), visible only
 * to them. Links may join works from any provider and the user's own; IDs of Sources merged
 * into another since are followed.
 *
 * @param {object} options
 * @param {{ getStoredWorks: (ids: string[]) => Promise<object[]> }} options.workService
 * @param {(ids: string[]) => Promise<Map<string, string>>} [options.resolveIds]
 */
export function createManualService({ workService, resolveIds = canonicalIdMap }) {
  /** The user's manual work with this ID, or a 404. */
  async function ownWork(userId, id) {
    const work = TRACER_ID_PATTERN.test(id ?? '')
      ? await ManualWork.findOne({ _id: id, userId }).exec()
      : null;
    if (!work) throw new HttpError(404, 'Work not found');
    return work;
  }

  /** `id` as stored: the user's manual work, or a Source (merged ones followed). 404 if neither. */
  async function endpoint(userId, id) {
    if (!TRACER_ID_PATTERN.test(id ?? '')) throw bad('Invalid work ID');
    if (await ManualWork.exists({ _id: id, userId })) return id;
    const canonical = (await resolveIds([id])).get(id) ?? id;
    if (!(await Source.exists({ _id: canonical }))) throw new HttpError(404, 'Work not found');
    return canonical;
  }

  return {
    /**
     * Everything the user added by hand: their works, their links, and the works from
     * providers those links name (from Tracer's database, no provider requests), so the client
     * can add a linked work that isn't on the graph yet.
     */
    async list(userId) {
      const [works, links] = await Promise.all([
        ManualWork.find({ userId }).sort({ createdAt: 1 }).lean().exec(),
        ManualLink.find({ userId }).sort({ createdAt: 1 }).lean().exec(),
      ]);
      const own = new Set(works.map((work) => String(work._id)));
      const providerIds = [
        ...new Set(links.flatMap((link) => [link.citingId, link.citedId])),
      ].filter((id) => !own.has(id));
      const redirects = await resolveIds(providerIds);
      const to = (id) => redirects.get(id) ?? id;
      const linkedWorks = await workService.getStoredWorks([...new Set(providerIds.map(to))]);
      return {
        works: works.map(manualWorkToWork),
        links: links.map((link) => ({
          id: String(link._id),
          citingId: own.has(link.citingId) ? link.citingId : to(link.citingId),
          citedId: own.has(link.citedId) ? link.citedId : to(link.citedId),
        })),
        linkedWorks,
      };
    },

    async createWork(userId, fields) {
      const checked = checkWork(fields);
      if ((await ManualWork.countDocuments({ userId })) >= MAX_WORKS) {
        throw new HttpError(409, `You can add up to ${MAX_WORKS} works by hand`);
      }
      return manualWorkToWork(await ManualWork.create({ userId, ...checked }));
    },

    async updateWork(userId, id, fields) {
      const work = await ownWork(userId, id);
      work.set(checkWork(fields));
      await work.save();
      return manualWorkToWork(work);
    },

    /** Deletes the user's manual work and every link to or from it. */
    async deleteWork(userId, id) {
      await ownWork(userId, id);
      await ManualLink.deleteMany({ userId, $or: [{ citingId: id }, { citedId: id }] });
      await ManualWork.deleteOne({ _id: id, userId });
    },

    /**
     * Records that `citingId` cites `citedId`, each a work Tracer knows or one of the user's.
     * Adding a link that exists already returns it.
     */
    async addLink(userId, { citingId, citedId } = {}) {
      const [citing, cited] = await Promise.all([
        endpoint(userId, citingId),
        endpoint(userId, citedId),
      ]);
      if (citing === cited) throw bad('A work can’t cite itself');
      const existing = await ManualLink.findOne({ userId, citingId: citing, citedId: cited })
        .lean()
        .exec();
      if (existing) return { id: String(existing._id), citingId: citing, citedId: cited };
      if ((await ManualLink.countDocuments({ userId })) >= MAX_LINKS) {
        throw new HttpError(409, `You can add up to ${MAX_LINKS} citations by hand`);
      }
      const link = await ManualLink.create({ userId, citingId: citing, citedId: cited });
      return { id: String(link._id), citingId: citing, citedId: cited };
    },

    async removeLink(userId, id) {
      if (!TRACER_ID_PATTERN.test(id ?? '')) throw new HttpError(404, 'Link not found');
      const { deletedCount } = await ManualLink.deleteOne({ _id: id, userId });
      if (!deletedCount) throw new HttpError(404, 'Link not found');
    },

    /** Whether `id` is one of the user's manual works. */
    async ownsWork(userId, id) {
      return (
        TRACER_ID_PATTERN.test(id ?? '') && Boolean(await ManualWork.exists({ _id: id, userId }))
      );
    },
  };
}

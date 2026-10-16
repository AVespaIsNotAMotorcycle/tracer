import { manualWorkToWork } from '../manual/manualService.js';
import { LibraryEntry, READING_STATUSES } from '../models/LibraryEntry.js';
import { ManualWork } from '../models/ManualWork.js';
import { SavedGraph } from '../models/SavedGraph.js';
import { Source } from '../models/Source.js';
import { HttpError } from '../works/errors.js';
import { canonicalIdMap } from '../works/merges.js';

const TRACER_ID_PATTERN = /^[0-9a-f]{24}$/i;
// The most works one library can hold (statuses; notes are limited per graph).
const MAX_ENTRIES = 20_000;

/**
 * A user's library: the reading status of each work they've tagged (to read, reading, read or
 * cited), and the works they've noted in any of their saved graphs. Statuses are per user, not
 * per graph. Work IDs are Tracer IDs; ones merged into another work since (see
 * works/merges.js) are followed, and the entries rewritten.
 *
 * @param {object} options
 * @param {{ getSummaries: (ids: string[]) => Promise<Map<string, object>> }} options.workService
 * @param {(ids: string[]) => Promise<Map<string, string>>} [options.resolveIds]
 */
export function createLibraryService({ workService, resolveIds = canonicalIdMap }) {
  /**
   * Moves the user's entries for works merged into another onto that work, keeping the most
   * recent status when both have one. Returns the user's entries afterwards.
   */
  async function currentEntries(userId) {
    const entries = await LibraryEntry.find({ userId }).sort({ updatedAt: -1 }).lean().exec();
    const redirects = await resolveIds(entries.map((entry) => entry.workId));
    if (redirects.size === 0) return entries;
    const kept = new Map();
    for (const entry of entries) {
      const workId = redirects.get(entry.workId) ?? entry.workId;
      // Most recent first, so the first one for a work is the one to keep.
      if (!kept.has(workId)) kept.set(workId, { ...entry, workId });
    }
    const stale = entries.filter((entry) => redirects.has(entry.workId));
    await LibraryEntry.deleteMany({ _id: { $in: stale.map((entry) => entry._id) } });
    await Promise.all(
      [...kept.values()]
        .filter((entry) => stale.some((s) => s._id.equals(entry._id)))
        .map(({ workId, status, updatedAt }) =>
          LibraryEntry.updateOne(
            { userId, workId },
            { $set: { status, updatedAt }, $setOnInsert: { createdAt: updatedAt } },
            { upsert: true, timestamps: false },
          ),
        ),
    );
    return LibraryEntry.find({ userId }).sort({ updatedAt: -1 }).lean().exec();
  }

  return {
    /** Every status the user has set: { [workId]: status }. */
    async statuses(userId) {
      const entries = await currentEntries(userId);
      return Object.fromEntries(entries.map((entry) => [entry.workId, entry.status]));
    },

    /**
     * Sets a work's reading status (null removes it from the library). The work must be one
     * Tracer knows; a merged one is stored under the work it was merged into.
     *
     * @returns {Promise<{ workId: string, status: string | null }>}
     */
    async setStatus(userId, workId, status) {
      if (!TRACER_ID_PATTERN.test(workId ?? '')) throw new HttpError(400, 'Invalid work ID');
      if (status !== null && !READING_STATUSES.includes(status)) {
        throw new HttpError(400, `status must be one of ${READING_STATUSES.join(', ')}, or null`);
      }
      const id = (await resolveIds([workId])).get(workId) ?? workId;
      if (status === null) {
        await LibraryEntry.deleteOne({ userId, workId: id });
        return { workId: id, status: null };
      }
      const known =
        (await Source.exists({ _id: id })) || (await ManualWork.exists({ _id: id, userId }));
      if (!known) throw new HttpError(404, 'Work not found');
      const existing = await LibraryEntry.exists({ userId, workId: id });
      if (!existing && (await LibraryEntry.countDocuments({ userId })) >= MAX_ENTRIES) {
        throw new HttpError(409, 'Your library is full');
      }
      await LibraryEntry.updateOne({ userId, workId: id }, { $set: { status } }, { upsert: true });
      return { workId: id, status };
    },

    /**
     * The library: every work the user has given a status or noted in a saved graph, most
     * recently changed first, each with a summary of the work (from Tracer's database; no
     * provider requests), its status, and its notes with the graphs they're in.
     *
     * @returns {Promise<{ workId: string, status: string | null, updatedAt: Date,
     *   work: object | null, notes: { graphId: string, graphName: string, body: string,
     *   updatedAt: Date }[] }[]>}
     */
    async list(userId) {
      const entries = await currentEntries(userId);
      const graphs = await SavedGraph.find({ userId }, { name: 1, annotations: 1 }).lean().exec();
      const notes = graphs.flatMap((graph) =>
        (graph.annotations ?? [])
          .filter((a) => a.kind === 'note' && a.target?.type === 'work' && a.body?.trim())
          .map((a) => ({
            workId: a.target.workId,
            graphId: String(graph._id),
            graphName: graph.name,
            body: a.body,
            updatedAt: a.updatedAt ?? a.createdAt ?? null,
          })),
      );
      const noteRedirects = await resolveIds(notes.map((note) => note.workId));
      const byWork = new Map();
      const entryFor = (workId) => {
        if (!byWork.has(workId)) {
          byWork.set(workId, { workId, status: null, updatedAt: null, work: null, notes: [] });
        }
        return byWork.get(workId);
      };
      for (const entry of entries) {
        Object.assign(entryFor(entry.workId), { status: entry.status, updatedAt: entry.updatedAt });
      }
      for (const { workId, ...note } of notes) {
        const item = entryFor(noteRedirects.get(workId) ?? workId);
        item.notes.push(note);
        if (note.updatedAt && (!item.updatedAt || note.updatedAt > item.updatedAt)) {
          item.updatedAt = note.updatedAt;
        }
      }
      const ids = [...byWork.keys()];
      const summaries = await workService.getSummaries(ids);
      // Works the user added by hand aren't Sources.
      const manual = await ManualWork.find({ _id: { $in: ids }, userId })
        .lean()
        .exec();
      for (const doc of manual) {
        const work = manualWorkToWork(doc);
        summaries.set(work.id, {
          id: work.id,
          title: work.title,
          authors: work.authors.map((author) => author.name),
          year: work.year,
          type: work.type,
          venue: work.venue,
          externalIds: work.externalIds,
          manual: true,
        });
      }
      for (const item of byWork.values()) item.work = summaries.get(item.workId) ?? null;
      return [...byWork.values()].sort(
        (a, b) => (b.updatedAt?.getTime?.() ?? 0) - (a.updatedAt?.getTime?.() ?? 0),
      );
    },
  };
}

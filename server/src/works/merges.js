// Merging Sources that are the same work: two OpenAlex records with one DOI, or a
// reference-only work and the OpenAlex work it turns out to be. The merged Source isn't
// deleted: it gets `mergedInto`, the Source it now lives in, and every lookup by its Tracer ID
// (or provider ID) follows that redirect, so IDs stored in saved graphs, snapshots and other
// Sources' reference lists keep working.
//
// Merges are conservative. A wrong merge (a book and a review of it, which share a title)
// loses a work from every graph it's on, which damages trust more than a visible duplicate.
// So a shared DOI or a Crossref match isn't enough: the records must also agree on title,
// year, kind of work and authors (sameWork).

import { Source } from '../models/Source.js';
import { fullTitle, mainTitle, surname } from './textMatch.js';

const MAX_YEAR_GAP = 1;
// Redirects are flattened when a Source is merged (see mergeSources), so one hop is the rule;
// the limit only guards against a cycle.
const MAX_HOPS = 5;
// A title that is another's main title (the same work cited without its subtitle) must be at
// least this long, so a one-word title doesn't match every work that starts with it.
const MIN_MAIN_TITLE = 12;
// Authors compared per work: enough to survive a different author order.
const AUTHORS_COMPARED = 5;

// Types of record that are never the same work as a record of another type: a review carries
// the title of the book it reviews, an erratum the title of the article it corrects.
const DISTINCT_TYPES = new Set([
  'review',
  'erratum',
  'paratext',
  'editorial',
  'letter',
  'retraction',
  'peer-review',
  'book-chapter',
]);

// Crossref's names for types, as OpenAlex names them.
const TYPE_ALIASES = {
  'journal-article': 'article',
  'proceedings-article': 'article',
  'posted-content': 'preprint',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
};

const kindOf = (type) => (type ? (TYPE_ALIASES[type] ?? type) : null);

/** Whether two types can be one work: the same, one unknown, or neither a distinct kind. */
function compatibleTypes(a, b) {
  const [x, y] = [kindOf(a), kindOf(b)];
  if (!x || !y || x === y) return true;
  if (DISTINCT_TYPES.has(x) || DISTINCT_TYPES.has(y)) return false;
  // A book is never an article (a review of a book is, often typed as one).
  return x !== 'book' && y !== 'book';
}

function sameTitle(a, b) {
  const [fullA, fullB] = [fullTitle(a), fullTitle(b)];
  if (!fullA || !fullB) return false;
  if (fullA === fullB) return true;
  // One cites the work without its subtitle.
  const [mainA, mainB] = [mainTitle(a), mainTitle(b)];
  return (
    (fullA === mainB && mainB.length >= MIN_MAIN_TITLE) ||
    (fullB === mainA && mainA.length >= MIN_MAIN_TITLE)
  );
}

const surnames = (authors) =>
  new Set(
    (authors ?? [])
      .slice(0, AUTHORS_COMPARED)
      .map((author) => surname(author.name ?? author.family))
      .filter(Boolean),
  );

/**
 * Whether two records describe the same work: the same title (or one is the other without its
 * subtitle), years at most one apart, compatible types (a review or chapter never matches
 * another kind of record, nor a book an article) and, when both list authors, at least one
 * surname in common. Records are ProviderWorks, CrossrefWorks or ProviderReferences:
 * `{ title, authors: [{ name }], year, type }`.
 *
 * @param {object} a
 * @param {object} b
 * @param {{ requireTitles?: boolean }} [options]  With `requireTitles: false` (for records
 *   already known to share a DOI), a missing title is no reason to refuse; different ones are.
 */
export function sameWork(a, b, { requireTitles = true } = {}) {
  if (a.title && b.title) {
    if (!sameTitle(a.title, b.title)) return false;
  } else if (requireTitles) {
    return false;
  }
  if (a.year != null && b.year != null && Math.abs(a.year - b.year) > MAX_YEAR_GAP) return false;
  if (!compatibleTypes(a.type, b.type)) return false;
  const [namesA, namesB] = [surnames(a.authors), surnames(b.authors)];
  if (namesA.size && namesB.size && ![...namesA].some((name) => namesB.has(name))) return false;
  return true;
}

const isTracerId = (id) => typeof id === 'string' && /^[0-9a-f]{24}$/i.test(id);

/**
 * The Source each of `ids` (Tracer IDs) now lives in, for those that were merged: a map from
 * each merged ID to its canonical ID. IDs that weren't merged (or aren't Tracer IDs) aren't in
 * it, so an empty map means nothing changed.
 *
 * @param {Iterable<string>} ids
 * @returns {Promise<Map<string, string>>}
 */
export async function canonicalIdMap(ids) {
  const current = new Map();
  for (const id of ids) if (isTracerId(id)) current.set(id, id);
  let pending = [...current.keys()];
  for (let hop = 0; hop < MAX_HOPS && pending.length; hop++) {
    const merged = await Source.find(
      { _id: { $in: pending }, mergedInto: { $exists: true } },
      { mergedInto: 1 },
    )
      .lean()
      .exec();
    if (merged.length === 0) break;
    const into = new Map(merged.map((s) => [String(s._id), String(s.mergedInto)]));
    for (const [id, now] of current) if (into.has(now)) current.set(id, into.get(now));
    pending = [...new Set(into.values())];
  }
  return new Map([...current].filter(([id, canonical]) => id !== canonical));
}

/**
 * Merges Source `fromId` into `intoId` (which must not itself be merged): `fromId` then
 * redirects there, and so does everything that was merged into it, so redirects stay one hop.
 * `reason` records why: 'doi' or 'citation-match'.
 */
export async function mergeSources(fromId, intoId, reason, at = new Date()) {
  if (String(fromId) === String(intoId)) return;
  await Source.updateOne(
    { _id: fromId, mergedInto: { $exists: false } },
    { $set: { mergedInto: intoId, mergedAt: at, mergeReason: reason } },
  );
  await Source.updateMany({ mergedInto: fromId }, { $set: { mergedInto: intoId } });
}

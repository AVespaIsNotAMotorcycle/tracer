// Where a work's data and its citation links came from, and warnings about data that's
// probably missing. Pure functions over works from the API, independent of React.
//
// The server lists, for each of a work's references, the providers that have that citation
// (`referenceProviders`): OpenAlex's own reference list, a reference list the publisher
// deposited with Crossref, or OpenCitations' citation index. Works from before that was sent
// (an older snapshot) and links added on the client have none: their source is unknown.

import { REFERENCE_ONLY } from './sourceTypeKeys.js';

/** Display names of the providers the server names. */
export const PROVIDER_LABELS = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  opencitations: 'OpenCitations',
};

export const providerLabel = (name) => PROVIDER_LABELS[name] ?? name;

/** The providers that have the citation from `citing` to `citedId`; [] when not recorded. */
export const linkProviders = (citing, citedId) => citing?.referenceProviders?.[citedId] ?? [];

/**
 * @typedef {object} GraphLink  A citation between a work and another on the graph.
 * @property {object} work  The other work.
 * @property {'cites' | 'cited-by'} direction  Whether the work cites the other or is cited by
 *   it.
 * @property {string[]} providers  Where the citation came from ([] when not recorded).
 */

/**
 * Every citation between work `id` and the other works in `works`, with where it came from:
 * the works it cites first, then those citing it, each in graph order.
 *
 * @param {Map<string, object>} works
 * @param {string} id
 * @returns {GraphLink[]}
 */
export function graphLinks(works, id) {
  const self = works.get(id);
  if (!self) return [];
  const cites = [...new Set(self.references)]
    .filter((ref) => ref !== id && works.has(ref))
    .map((ref) => ({
      work: works.get(ref),
      direction: 'cites',
      providers: linkProviders(self, ref),
    }));
  const citedBy = [...works.values()]
    .filter((other) => other.id !== id && other.references.includes(id))
    .map((other) => ({ work: other, direction: 'cited-by', providers: linkProviders(other, id) }));
  return [...cites, ...citedBy];
}

const PROVIDER_ORDER = Object.keys(PROVIDER_LABELS);
const providerRank = (name) => {
  const rank = PROVIDER_ORDER.indexOf(name);
  return rank === -1 ? PROVIDER_ORDER.length : rank;
};

/**
 * `links` grouped by exactly which providers have them, so each link counts once: those only
 * OpenAlex has, those both OpenAlex and Crossref have, and so on, largest group first. Each
 * group's providers are in a fixed order (OpenAlex, Crossref, OpenCitations, then others);
 * links with no recorded source are a group with no providers.
 *
 * @param {GraphLink[]} links
 * @returns {{ providers: string[], count: number }[]}
 */
export function groupByProviders(links) {
  const groups = new Map();
  for (const link of links) {
    const providers = [...new Set(link.providers)].sort(
      (a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b),
    );
    const key = providers.join(' ');
    const group = groups.get(key) ?? { providers, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

// Types of work that normally cite others, so an empty reference list means the data is
// missing rather than that the work cites nothing. Book reviews often cite only the book.
const CITING_TYPES = new Set([
  'article',
  'book',
  'book-chapter',
  'review',
  'conference-paper',
  'dissertation',
  'preprint',
  'report',
  'data-paper',
  'software-paper',
]);
// A work with no references is flagged once at least this many works cite it: then it looks
// like a starting point on the graph, with arrows only coming in.
export const NO_REFERENCES_MIN_CITED = 10;
// A work with fewer references than this is flagged once at least FEW_REFERENCES_MIN_CITED
// works cite it: scholarship that much cited rarely cites so little.
export const FEW_REFERENCES = 5;
export const FEW_REFERENCES_MIN_CITED = 100;

/**
 * @typedef {object} ReferenceWarning
 * @property {'none' | 'few'} kind  No references recorded, or suspiciously few.
 * @property {number} references  How many are recorded.
 * @property {number} citedByCount
 * @property {string[]} checked  Providers whose data on its references is included.
 */

/**
 * A warning when a work's reference list is probably incomplete: empty, or much shorter than
 * a work cited that often would have (see the thresholds above), such as E. P. Thompson's
 * 1971 article, which OpenAlex lists with thousands of citers and no references. Without the
 * warning, a work like that looks like an origin point. Null when there's nothing to flag.
 *
 * @param {object} work  A work as the graph shows it (a book with its chapters' references).
 * @returns {ReferenceWarning | null}
 */
export function referenceWarning(work) {
  if (!work || work.type === REFERENCE_ONLY || !CITING_TYPES.has(work.type)) return null;
  const citedByCount = work.citedByCount ?? 0;
  const references = new Set(work.references).size;
  const kind =
    references === 0 && citedByCount >= NO_REFERENCES_MIN_CITED
      ? 'none'
      : references > 0 && references < FEW_REFERENCES && citedByCount >= FEW_REFERENCES_MIN_CITED
        ? 'few'
        : null;
  if (!kind) return null;
  const checked = (work.providers ?? []).filter((name) => name in PROVIDER_LABELS);
  return { kind, references, citedByCount, checked };
}

/**
 * Reference warnings for every work that has one, by ID.
 *
 * @param {Map<string, object>} works
 * @returns {Map<string, ReferenceWarning>}
 */
export function referenceWarnings(works) {
  const warnings = new Map();
  for (const work of works.values()) {
    const warning = referenceWarning(work);
    if (warning) warnings.set(work.id, warning);
  }
  return warnings;
}

/** "OpenAlex and Crossref", "OpenAlex, Crossref and OpenCitations". */
export function listProviders(names) {
  const labels = names.map(providerLabel);
  return labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/** The warning as a sentence, for the details panel. */
export function describeWarning({ kind, references, citedByCount, checked }) {
  const where = checked.length ? ` in ${listProviders(checked)}` : '';
  const cited = `${citedByCount.toLocaleString('en')} works cite it`;
  return kind === 'none'
    ? `No references are recorded for this work${where}, though ${cited}. Its own citations are missing from the data, so it can look like a starting point on the graph without being one.`
    : `Only ${references} reference${references === 1 ? ' is' : 's are'} recorded for this work${where}, though ${cited}, so most of its own citations are probably missing.`;
}

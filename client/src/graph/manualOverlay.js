// Works and citations the user added by hand (see /api/manual), laid over the graph built from
// the providers. Like filters and book folding, it only changes what's shown and counted: the
// graph itself, which builds, expansions and re-anchoring work from, stays the providers' own,
// and the overlay is applied again whenever either changes. Pure, independent of React.

/**
 * @typedef {object} ManualData
 * @property {Map<string, object>} works  The user's own works (Work objects, `manual: true`).
 * @property {{ id: string, citingId: string, citedId: string }[]} links
 * @property {Map<string, object>} linkedWorks  Works from providers the links name.
 */

/** No manual data: the graph is shown as built. */
export const NO_MANUAL = { works: new Map(), links: [], linkedWorks: new Map() };

/**
 * The graph with the user's manual data laid over it: each manual citation between two works
 * on it added to the citing work's references (from the provider `manual`, so its source shows
 * as the user's), and any work a manual citation links to a work on the graph added too (a
 * cited work as 'cited', a citing one as 'citing'), repeatedly, so a chain of manual works
 * joins as a whole. Returns `graph` itself when there's nothing to add.
 *
 * @param {import('./graphModel.js').Graph} graph
 * @param {ManualData} manual
 * @returns {import('./graphModel.js').Graph}
 */
export function applyManual(graph, manual) {
  if (!manual || manual.links.length === 0 || graph.works.size === 0) return graph;
  const available = (id) => manual.works.get(id) ?? manual.linkedWorks.get(id);
  const works = new Map(graph.works);
  const relations = new Map(graph.relations);
  let added = true;
  while (added) {
    added = false;
    for (const { citingId, citedId } of manual.links) {
      if (works.has(citingId) && !works.has(citedId) && available(citedId)) {
        works.set(citedId, available(citedId));
        relations.set(citedId, 'cited');
        added = true;
      } else if (works.has(citedId) && !works.has(citingId) && available(citingId)) {
        works.set(citingId, available(citingId));
        relations.set(citingId, 'citing');
        added = true;
      }
    }
  }
  let changed = works.size !== graph.works.size;
  for (const { citingId, citedId } of manual.links) {
    const citing = works.get(citingId);
    if (!citing || !works.has(citedId)) continue;
    const providers = citing.referenceProviders?.[citedId] ?? [];
    if (citing.references.includes(citedId) && providers.includes('manual')) continue;
    works.set(citingId, {
      ...citing,
      references: citing.references.includes(citedId)
        ? citing.references
        : [...citing.references, citedId],
      referenceProviders: { ...citing.referenceProviders, [citedId]: [...providers, 'manual'] },
    });
    changed = true;
  }
  return changed ? { ...graph, works, relations } : graph;
}

/** The manual links touching work `id`, with the other end: [{ link, otherId, direction }]. */
export function manualLinksOf(manual, id) {
  return manual.links.flatMap((link) =>
    link.citingId === id
      ? [{ link, otherId: link.citedId, direction: 'cites' }]
      : link.citedId === id
        ? [{ link, otherId: link.citingId, direction: 'cited-by' }]
        : [],
  );
}

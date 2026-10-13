// The shortest chain of citations between two works, in either direction. Works in provider IDs;
// the provider's batched lookups (see getNeighborIds in openalex.js) do the fetching.

/**
 * How one work relates to the next along a path: it `cites` the next, or is `cited-by` it.
 *
 * @typedef {'cites' | 'cited-by'} PathLink
 */

/**
 * @typedef {object} Neighbors
 * @property {Map<string, { id: string, link: PathLink }[]>} links  For each work asked about,
 *   the works it cites and is cited by, and which.
 * @property {Map<string, number>} counts  Citation counts of any works the lookup happened to
 *   learn them for.
 * @property {boolean} [complete]  False when some lists were cut short.
 * @property {string[]} [missing]  Works asked about that the provider has no record of.
 */

/**
 * @typedef {object} PathResult
 * @property {{ id: string, link: PathLink | null }[] | null} path  From `fromId` to `toId`;
 *   each step's `link` says how the step before relates to it (null on the first). Null if no
 *   path was found.
 * @property {number} searched  Works whose neighbors were looked up.
 * @property {'found' | 'none' | 'budget'} outcome  `none`: everything linked to one end was
 *   searched without reaching the other; `budget`: it stopped at a limit first.
 * @property {boolean} complete  False if a neighbor list was cut short, so a shorter path
 *   could have been missed.
 */

/**
 * Breadth-first search from both ends, growing whichever side has the smaller frontier by a
 * whole level, so the first level where the sides meet gives the shortest length. Among the
 * paths of that length it picks the one whose works are cited most in total: every work on
 * any shortest path is collected (both sides keep all of a work's parents one level nearer
 * their start), their counts are looked up where unknown, and each side keeps its most-cited
 * way to each work.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {object} options
 * @param {(ids: string[]) => Promise<Neighbors>} options.neighbors
 * @param {(ids: string[]) => Promise<Map<string, number>>} options.citationCounts
 * @param {number} [options.maxSteps]  Longest path looked for.
 * @param {number} [options.maxWorks]  Most works whose neighbors are looked up, in all.
 * @param {number} [options.deadline]  Time (from `now`) after which no new level starts.
 * @param {() => number} [options.now]
 * @returns {Promise<PathResult>}
 */
export async function shortestPath(
  fromId,
  toId,
  { neighbors, citationCounts, maxSteps = 8, maxWorks = 5000, deadline = Infinity, now = Date.now },
) {
  const counts = new Map();
  const side = (start) => ({
    start,
    dist: new Map([[start, 0]]),
    parents: new Map([[start, []]]),
    frontier: [start],
    depth: 0,
  });
  const from = side(fromId);
  const to = side(toId);
  let searched = 0;
  let complete = true;

  const meetings = () => {
    let length = Infinity;
    let found = [];
    for (const [id, d] of from.dist) {
      if (!to.dist.has(id)) continue;
      const total = d + to.dist.get(id);
      if (total < length) {
        length = total;
        found = [id];
      } else if (total === length) {
        found.push(id);
      }
    }
    return found;
  };

  // Every work on some shortest path: the meeting points and their ancestors on each side.
  const ancestors = (s, meet) => {
    const seen = new Set(meet);
    const stack = [...meet];
    while (stack.length) {
      for (const { id } of s.parents.get(stack.pop()) ?? []) {
        if (!seen.has(id)) {
          seen.add(id);
          stack.push(id);
        }
      }
    }
    return [...seen].sort((a, b) => s.dist.get(a) - s.dist.get(b));
  };
  // Reference lists can name works the provider no longer has (deleted or merged records), so
  // the works on candidate paths are checked when their counts are looked up: any that are
  // gone are dropped, and the search goes on.
  const dead = new Set();
  const drop = (id) => {
    dead.add(id);
    for (const s of [from, to]) {
      s.dist.delete(id);
      s.parents.delete(id);
      s.frontier = s.frontier.filter((other) => other !== id);
    }
  };
  let meet;
  let onPaths;
  for (;;) {
    meet = meetings();
    if (meet.length > 0) {
      onPaths = { from: ancestors(from, meet), to: ancestors(to, meet) };
      const unknown = [...new Set([...onPaths.from, ...onPaths.to])].filter(
        (id) => !counts.has(id),
      );
      if (unknown.length) {
        const found = await citationCounts(unknown);
        for (const [id, count] of found) counts.set(id, count);
        const gone = unknown.filter((id) => !found.has(id) && id !== fromId && id !== toId);
        if (gone.length) {
          gone.forEach(drop);
          continue;
        }
      }
      break;
    }

    // A side with nothing left to search has reached everything linked to its start.
    if (from.frontier.length === 0 || to.frontier.length === 0) {
      return { path: null, searched, outcome: 'none', complete };
    }
    const grow = to.frontier.length < from.frontier.length ? to : from;
    if (
      from.depth + to.depth >= maxSteps ||
      searched + grow.frontier.length > maxWorks ||
      now() > deadline
    ) {
      return { path: null, searched, outcome: 'budget', complete };
    }
    const found = await neighbors(grow.frontier);
    for (const [id, count] of found.counts) counts.set(id, count);
    if (found.complete === false) complete = false;
    for (const id of found.missing ?? []) if (id !== fromId && id !== toId) drop(id);
    searched += grow.frontier.length;

    const depth = grow.depth + 1;
    const next = [];
    for (const id of grow.frontier) {
      for (const { id: other, link } of found.links.get(id) ?? []) {
        if (dead.has(other)) continue;
        const known = grow.dist.get(other);
        if (known == null) {
          grow.dist.set(other, depth);
          grow.parents.set(other, [{ id, link }]);
          next.push(other);
        } else if (known === depth && !grow.parents.get(other).some((p) => p.id === id)) {
          grow.parents.get(other).push({ id, link });
        }
      }
    }
    grow.frontier = next;
    grow.depth = depth;
  }

  const cites = (id) => counts.get(id) ?? 0;

  // The most-cited way from each side's start to each work on a shortest path, nearest first.
  const best = (s, ids) => {
    const total = new Map();
    const choice = new Map();
    for (const id of ids) {
      let top = null;
      for (const parent of s.parents.get(id)) {
        if (!total.has(parent.id)) continue;
        if (!top || total.get(parent.id) > total.get(top.id)) top = parent;
      }
      total.set(id, cites(id) + (top ? total.get(top.id) : 0));
      choice.set(id, top);
    }
    return { total, choice };
  };
  const fromBest = best(from, onPaths.from);
  const toBest = best(to, onPaths.to);
  let middle = meet[0];
  const score = (id) => fromBest.total.get(id) + toBest.total.get(id) - cites(id);
  for (const id of meet) if (score(id) > score(middle)) middle = id;

  // From the start to the meeting point, then on to the other end. Toward `toId`, each choice
  // records how the next work relates to the current one, so the link is turned around.
  const path = [];
  for (let id = middle; id != null; id = fromBest.choice.get(id)?.id) {
    path.unshift({ id, link: fromBest.choice.get(id)?.link ?? null });
  }
  const flip = (link) => (link === 'cites' ? 'cited-by' : 'cites');
  for (let id = middle; toBest.choice.get(id);) {
    const { id: next, link } = toBest.choice.get(id);
    path.push({ id: next, link: flip(link) });
    id = next;
  }
  return { path, searched, outcome: 'found', complete };
}

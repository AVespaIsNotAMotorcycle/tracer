// Lanes across the time axis for parts of the graph with no path between them. A work the user
// expanded (or added from a search) can bring in works with no citation path to the anchors';
// without lanes, the year force lays both groups along the same stretch of the axis, and they
// interleave as if related. Each connected component gets its own band across the axis
// instead. Pure, so it's testable without a canvas.

/**
 * The graph's connected components, ignoring citation direction: arrays of IDs. Those holding
 * anchors come first, in the order of their first anchor (so the primary anchor's is first),
 * then the rest by size (largest first), ties by first ID.
 *
 * @param {Iterable<string>} ids
 * @param {{ source: string | { id: string }, target: string | { id: string } }[]} links
 * @param {string[]} [anchorIds]
 * @returns {string[][]}
 */
export function connectedComponents(ids, links, anchorIds = []) {
  const parent = new Map();
  for (const id of ids) parent.set(id, id);
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path compression.
    while (parent.get(id) !== root) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const idOf = (end) => (typeof end === 'object' ? end.id : end);
  for (const link of links) {
    const a = idOf(link.source);
    const b = idOf(link.target);
    if (!parent.has(a) || !parent.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }
  const components = [...groups.values()].map((members) => members.sort());
  // The position of a component's first anchor, or Infinity for one without.
  const anchorOrder = (members) => {
    const index = anchorIds.findIndex((id) => members.includes(id));
    return index === -1 ? Infinity : index;
  };
  const order = new Map(components.map((members) => [members, anchorOrder(members)]));
  return components.sort((a, b) => {
    const anchorA = order.get(a);
    const anchorB = order.get(b);
    if (anchorA !== anchorB) return anchorA < anchorB ? -1 : 1;
    return b.length - a.length || (a[0] < b[0] ? -1 : 1);
  });
}

/**
 * @typedef {object} Extent  A component's span across the time axis.
 * @property {number} min  Lowest v of any member's edge.
 * @property {number} max  Highest.
 */

/**
 * The center across the axis each component should move to, so that components sit in bands
 * `gap` apart. The first (the anchor's) is centered on the axis. The others keep the side and
 * order they're on now, relative to it, so a component never jumps over another; each stacks
 * outward from the ones nearer the axis.
 *
 * @param {Extent[]} extents  In the order of connectedComponents.
 * @param {number} gap
 * @returns {number[]}  Target centers, in the same order.
 */
export function laneCenters(extents, gap) {
  if (extents.length === 0) return [];
  const half = (e) => (e.max - e.min) / 2;
  const center = (e) => (e.max + e.min) / 2;
  const targets = new Array(extents.length);
  targets[0] = 0;
  const reference = center(extents[0]);
  let top = half(extents[0]);
  let bottom = -half(extents[0]);
  const others = extents.map((extent, index) => ({ extent, index })).slice(1);
  // Above the anchor's component (or level with it, which then goes above), nearest first.
  const above = others
    .filter(({ extent }) => center(extent) >= reference)
    .sort((a, b) => center(a.extent) - center(b.extent) || a.index - b.index);
  const below = others
    .filter(({ extent }) => center(extent) < reference)
    .sort((a, b) => center(b.extent) - center(a.extent) || a.index - b.index);
  for (const { extent, index } of above) {
    targets[index] = top + gap + half(extent);
    top = targets[index] + half(extent);
  }
  for (const { extent, index } of below) {
    targets[index] = bottom - gap - half(extent);
    bottom = targets[index] - half(extent);
  }
  return targets;
}

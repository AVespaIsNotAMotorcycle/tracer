/**
 * Bends links around the circles they would otherwise cross.
 *
 * force-graph draws a curved link as a quadratic Bézier whose control point sits
 * `curvature * length` from the chord's midpoint, perpendicular to it. Along such a curve the
 * offset from the chord at fraction t of its length is 2t(1 - t) * d, where d is that control
 * distance. So each circle in the way rules out an interval of d, and the routing picks the d
 * closest to 0 (the straightest link) outside all of them.
 */

// Links never bend further than this (control distance as a fraction of length); past it a
// curve looks like a loop. A circle that can't be cleared within it is crossed instead.
export const MAX_CURVATURE = 0.6;
// Slices checked across each circle (see routeLink).
const SLICES = 9;

/**
 * Returns the curvature (force-graph's `linkCurvature`) that keeps a link from start to end
 * clear of `obstacles`, each `{ x, y, r }` with r already including any margin. Returns 0 when
 * a straight line is clear. When no curve within MAX_CURVATURE clears every circle, returns
 * the one crossing the fewest.
 *
 * Runs every frame for every link, so it counts with a sweep: O(n log n) in the circles near
 * the link, where checking each candidate bend against each circle was O(n²).
 */
export function routeLink(start, end, obstacles) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 0;
  const ux = dx / length;
  const uy = dy / length;

  // Forbidden ranges of control distance, per circle the curve could hit. A circle is the
  // union of its slices across the chord, so the curve misses it when it misses every slice;
  // checking a few slices (not just the one through the centre) keeps sloped curves clear.
  // Each circle's ranges are merged, so a bend inside them counts as one hit on that circle.
  const lows = [];
  const highs = [];
  const ranges = [];
  for (const { x, y, r } of obstacles) {
    const along = (x - start.x) * ux + (y - start.y) * uy;
    // force-graph's perpendicular is (uy, -ux): the direction of angle - 90°.
    const across = (x - start.x) * uy - (y - start.y) * ux;
    ranges.length = 0;
    for (let i = 0; i < SLICES; i++) {
      const offset = r * ((2 * i) / (SLICES - 1) - 1);
      const t = (along + offset) / length;
      if (t <= 0 || t >= 1) continue;
      const k = 2 * t * (1 - t);
      const half = Math.sqrt(r * r - offset * offset);
      // Even the furthest allowed bend can't reach this slice.
      if (Math.abs(across) - half > k * MAX_CURVATURE * length) continue;
      ranges.push([(across - half) / k, (across + half) / k]);
    }
    if (ranges.length === 0) continue;
    // Ranges are open: a bend exactly at an end just touches the circle. So only ranges that
    // strictly overlap merge.
    ranges.sort((a, b) => a[0] - b[0]);
    let [low, high] = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i][0] < high) high = Math.max(high, ranges[i][1]);
      else {
        lows.push(low);
        highs.push(high);
        [low, high] = ranges[i];
      }
    }
    lows.push(low);
    highs.push(high);
  }
  if (lows.length === 0) return 0;

  // A bend d hits the circles whose range has low < d < high: (lows below d) - (highs at or
  // below d). That count only changes at range ends, so the fewest hits is at an end, at 0,
  // or at the limit; sweep through them in order.
  const limit = MAX_CURVATURE * length;
  lows.sort((a, b) => a - b);
  highs.sort((a, b) => a - b);
  const candidates = [0, -limit, limit, ...lows, ...highs]
    .filter((d) => Math.abs(d) <= limit)
    .sort((a, b) => a - b);
  let best = 0;
  let bestHits = Infinity;
  let below = 0;
  let ended = 0;
  for (const d of candidates) {
    while (below < lows.length && lows[below] < d) below++;
    while (ended < highs.length && highs[ended] <= d) ended++;
    const hits = below - ended;
    if (hits < bestHits || (hits === bestHits && Math.abs(d) < Math.abs(best))) {
      best = d;
      bestHits = hits;
    }
  }
  return best / length;
}

/** force-graph's control point for a quadratic link with this curvature. */
export function controlPoint(start, end, curvature) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return {
    x: (start.x + end.x) / 2 + curvature * dy,
    y: (start.y + end.y) / 2 - curvature * dx,
  };
}

// Bundling: links sharing an end node, in the same citation direction, that leave it within
// BUNDLE_ANGLE of each other run as one trunk out to a junction, then branch.
export const BUNDLE_ANGLE = (20 * Math.PI) / 180;
// The trunk runs until its links would be BUNDLE_GAP apart, so nearly parallel links share
// more of their length...
const BUNDLE_GAP = 60;
// ...but never past this fraction of the shortest link, leaving room for the branches.
const BUNDLE_REACH = 0.6;
// Directions tried for a trunk, spread across the angles its links leave at, so a trunk can
// pass beside a circle instead of stopping at it.
const TRUNK_DIRECTIONS = 9;
// A trunk shorter than this beyond the node's edge isn't worth drawing.
const MIN_TRUNK = 8;
// Branches leave a junction along the trunk, with a control point this fraction of the
// branch's length beyond it, so they merge smoothly instead of meeting it at an angle.
const BRANCH_TANGENT = 0.35;
// Samples along a curve when checking that it clears every circle.
const CURVE_SAMPLES = 24;
// Side of a spatial-grid cell (graph units), about two typical circles across.
const GRID_CELL = 80;

/**
 * Buckets nodes by position, so finding the circles near a link or trunk looks only at the
 * cells it covers instead of every node. `near(box)` returns every node whose circle (radius
 * plus clearance) could overlap the box, and maybe a few more; callers still check distance.
 */
function createGrid(nodes, radius, clearance) {
  const cells = new Map();
  let maxR = 0;
  const cellOf = (value) => Math.floor(value / GRID_CELL);
  for (const node of nodes) {
    const key = `${cellOf(node.x)},${cellOf(node.y)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(node);
    maxR = Math.max(maxR, radius(node) + clearance);
  }
  return {
    near(minX, minY, maxX, maxY) {
      // A circle can overlap the box from a cell just outside it.
      const x0 = cellOf(minX - maxR);
      const x1 = cellOf(maxX + maxR);
      const y0 = cellOf(minY - maxR);
      const y1 = cellOf(maxY + maxR);
      // A huge box (a long link) covers more cells than there are nodes: just scan them.
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > nodes.length) return nodes;
      const found = [];
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const cell = cells.get(`${cx},${cy}`);
          if (cell) for (const node of cell) found.push(node);
        }
      return found;
    },
  };
}

/** Angle-sorted runs of entries whose directions span at most BUNDLE_ANGLE. */
function clusterByAngle(entries) {
  const sorted = [...entries].sort((a, b) => a.angle - b.angle);
  // Start after the widest gap, so a cluster straddling ±180° isn't split.
  let start = 0;
  let widest = -1;
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[(i + 1) % sorted.length];
    const gap = (next.angle - sorted[i].angle + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
    if (gap > widest) {
      widest = gap;
      start = (i + 1) % sorted.length;
    }
  }
  const ordered = [...sorted.slice(start), ...sorted.slice(0, start)];
  const clusters = [];
  let current = [];
  for (const entry of ordered) {
    const spread = current.length
      ? (entry.angle - current[0].angle + 2 * Math.PI) % (2 * Math.PI)
      : 0;
    if (current.length && spread > BUNDLE_ANGLE) {
      clusters.push(current);
      current = [];
    }
    current.push(entry);
  }
  if (current.length) clusters.push(current);
  return clusters;
}

/**
 * Builds a bundle from a cluster of links at `node`, or returns null when no trunk would be
 * long enough. A trunk runs until its links diverge (BUNDLE_GAP), stops before its shortest
 * link ends (BUNDLE_REACH) and short of any circle in its way. To merge links as far as
 * possible, it tries leaving out the shortest links (they still leave along the trunk, so they
 * look merged near the node) and turning within the links' angles to pass beside circles, and
 * keeps whichever merges the most line length.
 */
function makeBundle(node, cluster, outgoing, grid, radius, clearance) {
  // Angles relative to the cluster's first, which clusterByAngle keeps contiguous.
  const base = cluster[0].angle;
  const relative = (angle) => (angle - base + 4 * Math.PI) % (2 * Math.PI);
  const byLength = [...cluster].sort((a, b) => b.length - a.length);
  const longestCap = BUNDLE_REACH * byLength[1].length;
  const nearby = grid
    .near(node.x - longestCap, node.y - longestCap, node.x + longestCap, node.y + longestCap)
    .filter((other) => other !== node);

  // How far a trunk at `angle` gets before a circle: computed once per direction and reused
  // for every choice of links (the cap only depends on which links, the circles on direction).
  const blocked = new Map();
  const blockedAt = (angle) => {
    if (blocked.has(angle)) return blocked.get(angle);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let at = Infinity;
    for (const other of nearby) {
      const r = radius(other) + clearance;
      const along = (other.x - node.x) * ux + (other.y - node.y) * uy;
      const across = (other.x - node.x) * uy - (other.y - node.y) * ux;
      if (along > 0 && Math.abs(across) < r) at = Math.min(at, along - r);
    }
    blocked.set(angle, at);
    return at;
  };
  // Directions spread across the whole cluster; each choice of links uses those within its own
  // angles, plus its centre.
  const clusterHigh = Math.max(...cluster.map((entry) => relative(entry.angle)));
  const spreadAngles = Array.from(
    { length: TRUNK_DIRECTIONS },
    (_, k) => (k * clusterHigh) / (TRUNK_DIRECTIONS - 1),
  );

  let best = null;
  for (let count = 2; count <= byLength.length; count++) {
    const members = byLength.slice(0, count);
    const angles = members.map((entry) => relative(entry.angle));
    const low = Math.min(...angles);
    const high = Math.max(...angles);
    const byDivergence = BUNDLE_GAP / Math.max(high - low, 1e-3);
    const byShortest = BUNDLE_REACH * members[count - 1].length;
    const cap = Math.min(byDivergence, byShortest);
    // Can't beat the best so far even with nothing in the way.
    if ((count - 1) * cap <= (best?.score ?? 0)) continue;
    // The centre first, so ties keep the trunk centred.
    const candidates = [(low + high) / 2, ...spreadAngles.filter((a) => a >= low && a <= high)];
    for (const offset of candidates) {
      const angle = base + offset;
      const block = blockedAt(angle);
      const reach = Math.min(cap, block);
      const limitedBy =
        block < cap ? 'circle' : byDivergence <= byShortest ? 'divergence' : 'shortest';
      const score = (count - 1) * reach;
      if (reach >= radius(node) + MIN_TRUNK && score > (best?.score ?? 0)) {
        best = { score, members, angle, reach, limitedBy };
      }
    }
  }
  if (!best) return null;

  const { members, angle, reach, limitedBy } = best;
  const direction = { x: Math.cos(angle), y: Math.sin(angle) };
  const bundle = {
    node,
    outgoing,
    reach,
    limitedBy,
    direction,
    // How far the trunk turns from its links' mean direction, kept as they move (placeBundle).
    turn: angle - Math.atan2(...meanDirection(node, members, outgoing).reverse()),
    junction: { x: node.x + direction.x * reach, y: node.y + direction.y * reach },
    links: members.map((entry) => entry.link),
  };
  return bundle;
}

/** Unit vector [x, y] of the mean direction from `node` to the other ends of `entries`. */
function meanDirection(node, entries, outgoing) {
  let ux = 0;
  let uy = 0;
  for (const entry of entries) {
    const link = entry.link ?? entry;
    const other = outgoing ? link.target : link.source;
    const length = Math.hypot(other.x - node.x, other.y - node.y);
    if (length > 0) {
      ux += (other.x - node.x) / length;
      uy += (other.y - node.y) / length;
    }
  }
  const norm = Math.hypot(ux, uy) || 1;
  return [ux / norm, uy / norm];
}

/**
 * Moves a bundle's trunk to where its node and links are now, keeping its planned reach and its
 * turn from the links' mean direction.
 */
function placeBundle(bundle) {
  const { node, outgoing, links, reach, turn } = bundle;
  const [mx, my] = meanDirection(node, links, outgoing);
  const angle = Math.atan2(my, mx) + turn;
  bundle.direction = { x: Math.cos(angle), y: Math.sin(angle) };
  bundle.junction = {
    x: node.x + bundle.direction.x * reach,
    y: node.y + bundle.direction.y * reach,
  };
}

/**
 * How far along `bundle`'s trunk `link` joins it: at the junction unless it merged in earlier,
 * where it crossed the trunk (see mergeCrossings).
 */
export function joinOf(bundle, link) {
  return bundle.joins?.get(link) ?? bundle.reach;
}

/** The point `distance` along a bundle's trunk; its junction at the full reach. */
function pointAlong(bundle, distance) {
  if (distance >= bundle.reach) return bundle.junction;
  return {
    x: bundle.node.x + bundle.direction.x * distance,
    y: bundle.node.y + bundle.direction.y * distance,
  };
}

/** How many of a bundle's links run along its trunk at `distance` from its node. */
export function linksAt(bundle, distance) {
  return bundle.links.filter((link) => joinOf(bundle, link) >= distance - 1e-9).length;
}

/**
 * A bundle's trunk as segments from its node outward, each with the number of links it
 * carries: every link up to the first join point, fewer beyond each one.
 *
 * @returns {{ from: number, to: number, count: number }[]}
 */
export function trunkSegments(bundle) {
  const joins = [...new Set(bundle.links.map((link) => joinOf(bundle, link)))].sort(
    (a, b) => a - b,
  );
  const segments = [];
  let from = 0;
  for (const to of joins) {
    segments.push({ from, to, count: linksAt(bundle, to) });
    from = to;
  }
  return segments;
}

/**
 * Sets a link's route geometry from its plan and the current positions: start and end (a
 * junction, or the node), and the control points of its curve.
 */
function placeRoute(link) {
  const { route, source, target } = link;
  const { sourceBundle, targetBundle } = route;
  route.start = sourceBundle ? pointAlong(sourceBundle, joinOf(sourceBundle, link)) : source;
  route.end = targetBundle ? pointAlong(targetBundle, joinOf(targetBundle, link)) : target;
  if (route.tangent) {
    const length = Math.hypot(route.end.x - route.start.x, route.end.y - route.start.y);
    const along = (bundle, end) =>
      bundle
        ? {
            x: end.x + bundle.direction.x * BRANCH_TANGENT * length,
            y: end.y + bundle.direction.y * BRANCH_TANGENT * length,
          }
        : end;
    route.controls = [along(sourceBundle, route.start), along(targetBundle, route.end)];
  } else {
    route.controls = route.curvature ? [controlPoint(route.start, route.end, route.curvature)] : [];
  }
}

/**
 * Updates every link's route to the nodes' current positions without re-planning it: bundles,
 * trunk lengths and bends (as curvatures, relative to each link) stay as layoutLinks last
 * planned them. Cheap enough for every frame; re-plan every few frames while nodes move.
 *
 * @param {object[]} links
 * @param {object[]} bundles  As returned by layoutLinks.
 */
export function placeLinks(links, bundles) {
  for (const bundle of bundles) placeBundle(bundle);
  for (const link of links) if (link.route) placeRoute(link);
}

/**
 * Lays out every visible link: bundles links that leave a node close together (see
 * BUNDLE_ANGLE), then bends each link's free part around the circles in `nodes`.
 *
 * Sets `link.route = { start, controls, end, sourceBundle, targetBundle }` on each visible
 * link: the free part is a Bézier curve from `start` to `end` (where it joins a trunk, or the
 * node itself) through `controls` (none for a straight line, one for quadratic, two for
 * cubic), and the bundles' trunks join it to the nodes. A branch leaves its trunk smoothly
 * when that curve is clear; otherwise it bends around circles like any other link. The plan
 * behind it is kept on the route too (`tangent`, or a `curvature`), so placeLinks can follow
 * moving nodes cheaply. Links that cross, or come within `mergeDistance` of each other, on
 * their way to the same node are merged there (mergeCrossings), unless `mergeCrossings` is
 * false.
 *
 * Returns the bundles. `radius(node)` gives a node's radius; `clearance` is the gap kept around
 * each circle.
 */
export function layoutLinks(
  links,
  nodes,
  radius,
  clearance,
  isVisible = () => true,
  { mergeCrossings: merge = true, mergeDistance = 0 } = {},
) {
  const placed = nodes.filter((node) => node.x != null);
  const grid = createGrid(placed, radius, clearance);
  const visible = [];
  for (const link of links) {
    const { source, target } = link;
    link.route = null;
    if (typeof source !== 'object' || source.x == null || target.x == null || !isVisible(link))
      continue;
    visible.push(link);
    link.route = { sourceBundle: null, targetBundle: null };
  }

  // Group link ends by node and direction: a bundle's links all point the same way.
  const groups = new Map();
  const addEnd = (node, other, link, outgoing) => {
    const key = `${outgoing ? 'out' : 'in'}:${node.id}`;
    if (!groups.has(key)) groups.set(key, { node, outgoing, entries: [] });
    groups.get(key).entries.push({
      link,
      angle: Math.atan2(other.y - node.y, other.x - node.x),
      length: Math.hypot(other.x - node.x, other.y - node.y),
    });
  };
  for (const link of visible) {
    addEnd(link.source, link.target, link, true);
    addEnd(link.target, link.source, link, false);
  }

  const bundles = [];
  for (const { node, outgoing, entries } of groups.values()) {
    if (entries.length < 2) continue;
    for (const cluster of clusterByAngle(entries)) {
      if (cluster.length < 2) continue;
      const bundle = makeBundle(node, cluster, outgoing, grid, radius, clearance);
      if (!bundle) continue;
      bundles.push(bundle);
      for (const link of bundle.links)
        link.route[outgoing ? 'sourceBundle' : 'targetBundle'] = bundle;
    }
  }

  for (const link of visible) routeFree(link, grid, radius, clearance);
  // Merging at crossings is the costly part; callers skip it while nodes are moving.
  if (merge) mergeCrossings(visible, bundles, grid, radius, clearance, mergeDistance);
  return bundles;
}

// Segments per curve when looking for crossings between links, and the hash cell size used to
// find segments that might cross.
const CROSSING_SAMPLES = 12;
const CROSSING_CELL = 40;
// Packing for the crossing hash: room for a path's segments (a trunk plus CROSSING_SAMPLES),
// and for cell coordinates in one numeric key.
const SEGMENT_SLOTS = 16;
const CELL_KEY_SPAN = 1 << 20;

/**
 * The path a link takes away from one of its ends, `node` (its source if `outgoing`), as a
 * polyline: along its trunk if it's bundled there, then along its curve to the far end.
 */
function pathFrom(link, outgoing) {
  const { route } = link;
  const points = [];
  for (let i = 0; i <= CROSSING_SAMPLES; i++) {
    const t = i / CROSSING_SAMPLES;
    points.push(pointOnCurve(route.start, route.controls, route.end, outgoing ? t : 1 - t));
  }
  const bundle = outgoing ? route.sourceBundle : route.targetBundle;
  if (bundle) points.unshift({ x: bundle.node.x, y: bundle.node.y });
  return points;
}

/** The point on segment a-b closest to p. */
function closestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
    : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/**
 * How close segments p1-p2 and q1-q2 come, and where: the crossing if they cross, otherwise the
 * midpoint between their closest points.
 */
function closestApproach(p1, p2, q1, q2) {
  const crossing = segmentCrossing(p1, p2, q1, q2);
  if (crossing) return { distance: 0, point: crossing };
  let best = null;
  for (const [p, a, b] of [
    [p1, q1, q2],
    [p2, q1, q2],
    [q1, p1, p2],
    [q2, p1, p2],
  ]) {
    const c = closestOnSegment(p, a, b);
    const distance = Math.hypot(p.x - c.x, p.y - c.y);
    if (!best || distance < best.distance)
      best = { distance, point: { x: (p.x + c.x) / 2, y: (p.y + c.y) / 2 } };
  }
  return best;
}

/** Where segments p1-p2 and q1-q2 cross, or null. */
function segmentCrossing(p1, p2, q1, q2) {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / denom;
  const u = ((q1.x - p1.x) * ry - (q1.y - p1.y) * rx) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { x: p1.x + t * rx, y: p1.y + t * ry };
}

/**
 * Pairs of links that share an end node, in the same citation direction, and cross or come
 * within `near` of each other on their way to it (after layoutLinks has routed them). Straight
 * links to one node only cross at the node, so crossings come from curves: links bent around
 * circles, branches, other trunks. Ignores meetings within `margin` of the node itself and
 * between links of the same bundle. Each pair is reported once, where it first meets on the
 * way in: the meeting furthest from the node (a crossing, or the midpoint of the closest
 * approach). With `onlyAt`, a set of nodes, only links meeting at those are checked.
 *
 * @returns {{ node: object, outgoing: boolean, a: object, b: object, point: {x, y},
 *   kind: 'loose' | 'joins-bundle' | 'between-bundles' }[]}
 */
export function findCrossings(links, margin, near = 0, onlyAt = null) {
  const groups = new Map();
  for (const link of links) {
    if (!link.route?.controls) continue;
    for (const outgoing of [true, false]) {
      const node = outgoing ? link.source : link.target;
      if (onlyAt && !onlyAt.has(node)) continue;
      const key = `${outgoing ? 'out' : 'in'}:${node.id}`;
      if (!groups.has(key)) groups.set(key, { node, outgoing, paths: [] });
      groups.get(key).paths.push({ link, points: pathFrom(link, outgoing) });
    }
  }
  const crossings = [];
  for (const { node, outgoing, paths } of groups.values()) {
    if (paths.length < 2) continue;
    const reach = margin(node);
    // Hash each path's segments by grid cell, so only segments sharing a cell are compared.
    // An entry is path * SEGMENT_SLOTS + segment; its first cell is kept to check each pair of
    // segments only once, in the first cell their padded boxes share.
    const cells = new Map();
    const firstCellX = [];
    const firstCellY = [];
    const pad = near / 2; // So segments within `near` share a cell.
    paths.forEach(({ points }, path) => {
      for (let segment = 1; segment < points.length; segment++) {
        const p = points[segment - 1];
        const q = points[segment];
        // Meetings this close to the node don't count, and every link converges here.
        if (
          Math.hypot(p.x - node.x, p.y - node.y) < reach &&
          Math.hypot(q.x - node.x, q.y - node.y) < reach
        )
          continue;
        const x0 = Math.floor((Math.min(p.x, q.x) - pad) / CROSSING_CELL);
        const x1 = Math.floor((Math.max(p.x, q.x) + pad) / CROSSING_CELL);
        const y0 = Math.floor((Math.min(p.y, q.y) - pad) / CROSSING_CELL);
        const y1 = Math.floor((Math.max(p.y, q.y) + pad) / CROSSING_CELL);
        const entry = path * SEGMENT_SLOTS + segment;
        firstCellX[entry] = x0;
        firstCellY[entry] = y0;
        for (let cx = x0; cx <= x1; cx++)
          for (let cy = y0; cy <= y1; cy++) {
            const key = cx * CELL_KEY_SPAN + cy;
            const list = cells.get(key);
            if (list) list.push(entry);
            else cells.set(key, [entry]);
          }
      }
    });
    const side = outgoing ? 'sourceBundle' : 'targetBundle';
    // Furthest crossing from the node per pair of paths.
    const furthest = new Map();
    for (const [key, entries] of cells) {
      const cx = Math.round(key / CELL_KEY_SPAN);
      const cy = key - cx * CELL_KEY_SPAN;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          let ei = entries[i];
          let ej = entries[j];
          // Shared by more cells than this one: check it only in the first.
          if (
            Math.max(firstCellX[ei], firstCellX[ej]) !== cx ||
            Math.max(firstCellY[ei], firstCellY[ej]) !== cy
          )
            continue;
          if (ei > ej) [ei, ej] = [ej, ei];
          const pi = Math.floor(ei / SEGMENT_SLOTS);
          const pj = Math.floor(ej / SEGMENT_SLOTS);
          if (pi === pj) continue;
          const si = ei - pi * SEGMENT_SLOTS;
          const sj = ej - pj * SEGMENT_SLOTS;
          const a = paths[pi];
          const b = paths[pj];
          const bundleA = a.link.route[side];
          if (bundleA && bundleA === b.link.route[side]) continue;
          const p1 = a.points[si - 1];
          const p2 = a.points[si];
          const q1 = b.points[sj - 1];
          const q2 = b.points[sj];
          // Cheap rejection: their boxes, padded by `near`, don't overlap.
          if (
            Math.max(p1.x, p2.x) + near < Math.min(q1.x, q2.x) ||
            Math.max(q1.x, q2.x) + near < Math.min(p1.x, p2.x) ||
            Math.max(p1.y, p2.y) + near < Math.min(q1.y, q2.y) ||
            Math.max(q1.y, q2.y) + near < Math.min(p1.y, p2.y)
          )
            continue;
          const approach = closestApproach(p1, p2, q1, q2);
          if (approach.distance > near) continue;
          const { point } = approach;
          const distance = Math.hypot(point.x - node.x, point.y - node.y);
          if (distance <= reach) continue;
          const pairKey = pi * paths.length + pj;
          const known = furthest.get(pairKey);
          if (!known || known.distance < distance)
            furthest.set(pairKey, { a: a.link, b: b.link, point, distance });
        }
      }
    }
    for (const { a, b, point } of furthest.values()) {
      const bundleA = a.route[side];
      const bundleB = b.route[side];
      const kind =
        bundleA && bundleB ? 'between-bundles' : bundleA || bundleB ? 'joins-bundle' : 'loose';
      crossings.push({ node, outgoing, a, b, point, kind });
    }
  }
  return crossings;
}

/**
 * Routes a link's free part (between its ends or their trunks): smoothly along its trunks when
 * that's clear, otherwise bent around the circles in its way.
 */
function routeFree(link, grid, radius, clearance) {
  const { route, source, target } = link;
  const { sourceBundle, targetBundle } = route;
  route.tangent = false;
  route.curvature = 0;
  const start = sourceBundle ? pointAlong(sourceBundle, joinOf(sourceBundle, link)) : source;
  const end = targetBundle ? pointAlong(targetBundle, joinOf(targetBundle, link)) : target;
  const obstacles = obstaclesNear(start, end, grid, [source, target], radius, clearance);
  if (sourceBundle || targetBundle) {
    route.tangent = true;
    placeRoute(link);
    if (curveClear(route.start, route.controls, route.end, obstacles)) return;
    route.tangent = false;
  }
  route.curvature = routeLink(start, end, obstacles);
  placeRoute(link);
}

// Crossings this close to a node, or to a trunk's line, count as at it.
const CROSSING_TOLERANCE = 6;
// Passes of merging at crossings; re-routing merged links can create new crossings.
const CROSSING_PASSES = 4;

/**
 * Merges links that cross, or come within `near` of each other, on their way to the same node,
 * so they run as one line from there to the node (see findCrossings):
 * - Meeting on a bundle's trunk: the other link joins that trunk there.
 * - Meeting beyond a junction (on branches): the other link joins that bundle at its
 *   junction, just before the meeting. Between two bundles, the longer trunk takes it.
 * - When the other link is itself bundled, its whole bundle joins, not just that link.
 * - Two links in no bundle: they become a bundle whose junction is the crossing, if a straight
 *   trunk to it is clear of circles.
 * Bundles left with one link are dissolved. Affected links are re-routed.
 */
function mergeCrossings(links, bundles, grid, radius, clearance, near = 0) {
  const margin = (node) => radius(node) + MIN_TRUNK;
  // A meeting this close to a trunk's line counts as on the trunk.
  const tolerance = Math.max(CROSSING_TOLERANCE, near);
  // After the first pass, only nodes where a link moved can have new meetings.
  let onlyAt = null;
  for (let pass = 0; pass < CROSSING_PASSES; pass++) {
    const crossings = findCrossings(links, margin, near, onlyAt);
    if (crossings.length === 0) return;
    const moved = new Set();
    const touched = new Set();
    for (const { node, outgoing, a, b, point } of crossings) {
      if (moved.has(a) || moved.has(b)) continue;
      const side = outgoing ? 'sourceBundle' : 'targetBundle';
      const bundleA = a.route[side];
      const bundleB = b.route[side];
      const distance = Math.hypot(point.x - node.x, point.y - node.y);
      const onTrunk = (bundle) => {
        if (!bundle) return false;
        const along =
          (point.x - node.x) * bundle.direction.x + (point.y - node.y) * bundle.direction.y;
        const across =
          (point.x - node.x) * bundle.direction.y - (point.y - node.y) * bundle.direction.x;
        return along <= bundle.reach + tolerance && Math.abs(across) < tolerance;
      };
      const join = (link, bundle, at) => {
        const from = link.route[side];
        if (from === bundle) return;
        if (from) {
          from.links = from.links.filter((other) => other !== link);
          from.joins?.delete(link);
          touched.add(from);
        }
        bundle.links.push(link);
        link.route[side] = bundle;
        bundle.joins ??= new Map();
        if (at < bundle.reach) bundle.joins.set(link, at);
        touched.add(bundle);
        moved.add(link);
      };
      if (bundleA || bundleB) {
        // The trunk they meet on takes the other link, at the meeting point; meeting on
        // branches, the longer trunk takes it at its junction.
        let host;
        let at;
        if (onTrunk(bundleA) || onTrunk(bundleB)) {
          host = onTrunk(bundleA) ? bundleA : bundleB;
          at = Math.min(distance, host.reach);
        } else {
          host = bundleA && (!bundleB || bundleA.reach >= bundleB.reach) ? bundleA : bundleB;
          at = host.reach;
        }
        const other = host === bundleA ? b : a;
        // A bundle meeting another joins it whole, rather than one link per pass.
        const joining = other.route[side] ? [...other.route[side].links] : [other];
        for (const link of joining) join(link, host, at);
      } else {
        const bundle = bundleAt(node, outgoing, [a, b], point, grid, radius, clearance);
        if (!bundle) continue;
        bundles.push(bundle);
        for (const link of [a, b]) {
          link.route[side] = bundle;
          moved.add(link);
        }
        touched.add(bundle);
      }
    }
    // A bundle needs two links; a lone one runs on its own again.
    for (const bundle of touched) {
      if (bundle.links.length >= 2) continue;
      const side = bundle.outgoing ? 'sourceBundle' : 'targetBundle';
      for (const link of bundle.links) {
        link.route[side] = null;
        moved.add(link);
      }
      bundles.splice(bundles.indexOf(bundle), 1);
    }
    for (const bundle of touched) for (const link of bundle.links) moved.add(link);
    for (const link of moved) routeFree(link, grid, radius, clearance);
    onlyAt = new Set([...moved].flatMap((link) => [link.source, link.target]));
  }
}

/**
 * mergeCrossings for links already routed (exported for tests): merges, re-routes, and
 * updates `bundles` in place.
 */
export function mergeAtCrossings(links, bundles, nodes, radius, clearance, near = 0) {
  const placed = nodes.filter((node) => node.x != null);
  mergeCrossings(links, bundles, createGrid(placed, radius, clearance), radius, clearance, near);
}

/**
 * A bundle of `links` at `node` whose trunk runs straight to `point`, or null if that trunk
 * would be too short or cross a circle.
 */
function bundleAt(node, outgoing, links, point, grid, radius, clearance) {
  const reach = Math.hypot(point.x - node.x, point.y - node.y);
  if (reach < radius(node) + MIN_TRUNK) return null;
  const ux = (point.x - node.x) / reach;
  const uy = (point.y - node.y) / reach;
  const nearby = grid.near(
    Math.min(node.x, point.x),
    Math.min(node.y, point.y),
    Math.max(node.x, point.x),
    Math.max(node.y, point.y),
  );
  for (const other of nearby) {
    if (other === node) continue;
    const r = radius(other) + clearance;
    const along = (other.x - node.x) * ux + (other.y - node.y) * uy;
    const across = (other.x - node.x) * uy - (other.y - node.y) * ux;
    if (along > 0 && along - r < reach && Math.abs(across) < r) return null;
  }
  const angle = Math.atan2(uy, ux);
  return {
    node,
    outgoing,
    reach,
    limitedBy: 'crossing',
    direction: { x: ux, y: uy },
    turn: angle - Math.atan2(...meanDirection(node, links, outgoing).reverse()),
    junction: { x: point.x, y: point.y },
    links: [...links],
  };
}

/** A point on the Bézier curve from start through controls to end, at t in [0, 1]. */
export function pointOnCurve(start, controls, end, t) {
  let points = [start, ...controls, end];
  // de Casteljau: repeatedly interpolate between neighbouring points.
  while (points.length > 1) {
    points = points.slice(1).map((p, i) => ({
      x: points[i].x + (p.x - points[i].x) * t,
      y: points[i].y + (p.y - points[i].y) * t,
    }));
  }
  return points[0];
}

/** Whether the curve keeps out of every obstacle circle (checked at CURVE_SAMPLES points). */
function curveClear(start, controls, end, obstacles) {
  for (let i = 1; i < CURVE_SAMPLES; i++) {
    const point = pointOnCurve(start, controls, end, i / CURVE_SAMPLES);
    for (const { x, y, r } of obstacles) if (Math.hypot(point.x - x, point.y - y) < r) return false;
  }
  return true;
}

/** Circles near enough to the segment start-end that an allowed curve could hit them. */
function obstaclesNear(start, end, grid, skip, radius, clearance) {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const reach = MAX_CURVATURE * Math.hypot(end.x - start.x, end.y - start.y) * 0.5;
  const obstacles = [];
  for (const node of grid.near(minX - reach, minY - reach, maxX + reach, maxY + reach)) {
    if (skip.includes(node)) continue;
    const r = radius(node) + clearance;
    if (
      node.x + r < minX - reach ||
      node.x - r > maxX + reach ||
      node.y + r < minY - reach ||
      node.y - r > maxY + reach
    )
      continue;
    obstacles.push({ x: node.x, y: node.y, r });
  }
  return obstacles;
}

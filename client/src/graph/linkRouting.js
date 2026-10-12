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
const BUNDLE_REACH = 0.45;
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
 * Builds a bundle from a cluster of links at `node`, or returns null when their trunk would be
 * too short. The trunk stops short of any circle in its way.
 */
function makeBundle(node, cluster, outgoing, grid, radius, clearance) {
  let ux = 0;
  let uy = 0;
  for (const { angle } of cluster) {
    ux += Math.cos(angle);
    uy += Math.sin(angle);
  }
  const norm = Math.hypot(ux, uy);
  ux /= norm;
  uy /= norm;
  const spread = (cluster.at(-1).angle - cluster[0].angle + 2 * Math.PI) % (2 * Math.PI);
  const shortest = Math.min(...cluster.map((entry) => entry.length));
  let reach = Math.min(BUNDLE_GAP / Math.max(spread, 1e-3), BUNDLE_REACH * shortest);
  const tipX = node.x + ux * reach;
  const tipY = node.y + uy * reach;
  const nearby = grid.near(
    Math.min(node.x, tipX),
    Math.min(node.y, tipY),
    Math.max(node.x, tipX),
    Math.max(node.y, tipY),
  );
  for (const other of nearby) {
    if (other === node) continue;
    const r = radius(other) + clearance;
    const along = (other.x - node.x) * ux + (other.y - node.y) * uy;
    const across = (other.x - node.x) * uy - (other.y - node.y) * ux;
    if (along > 0 && along - r < reach && Math.abs(across) < r) reach = along - r;
  }
  if (reach < radius(node) + MIN_TRUNK) return null;
  return {
    node,
    outgoing,
    reach,
    direction: { x: ux, y: uy },
    junction: { x: node.x + ux * reach, y: node.y + uy * reach },
    links: cluster.map((entry) => entry.link),
  };
}

/**
 * Moves a bundle's trunk to where its node and links are now, keeping its planned reach: the
 * direction is the mean of its links' current directions.
 */
function placeBundle(bundle) {
  const { node, outgoing, links, reach } = bundle;
  let ux = 0;
  let uy = 0;
  for (const link of links) {
    const other = outgoing ? link.target : link.source;
    const length = Math.hypot(other.x - node.x, other.y - node.y);
    if (length > 0) {
      ux += (other.x - node.x) / length;
      uy += (other.y - node.y) / length;
    }
  }
  const norm = Math.hypot(ux, uy);
  if (norm > 0) bundle.direction = { x: ux / norm, y: uy / norm };
  bundle.junction = {
    x: node.x + bundle.direction.x * reach,
    y: node.y + bundle.direction.y * reach,
  };
}

/**
 * Sets a link's route geometry from its plan and the current positions: start and end (a
 * junction, or the node), and the control points of its curve.
 */
function placeRoute(link) {
  const { route, source, target } = link;
  const { sourceBundle, targetBundle } = route;
  route.start = sourceBundle?.junction ?? source;
  route.end = targetBundle?.junction ?? target;
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
 * link: the free part is a Bézier curve from `start` to `end` (a bundle's junction, or the
 * node itself) through `controls` (none for a straight line, one for quadratic, two for
 * cubic), and the bundles' trunks join it to the nodes. The plan behind it is kept on the
 * route too (`tangent`, or a `curvature`), so placeLinks can follow moving nodes cheaply. A branch leaves its junction along
 * the trunk when that curve is clear; otherwise it bends around circles like any other link.
 * Returns the bundles. `radius(node)` gives a node's radius; `clearance` is the gap kept around
 * each circle.
 */
export function layoutLinks(links, nodes, radius, clearance, isVisible = () => true) {
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

  for (const link of visible) {
    const { route, source, target } = link;
    const { sourceBundle, targetBundle } = route;
    route.tangent = false;
    route.curvature = 0;
    const start = sourceBundle?.junction ?? source;
    const end = targetBundle?.junction ?? target;
    const obstacles = obstaclesNear(start, end, grid, [source, target], radius, clearance);
    if (sourceBundle || targetBundle) {
      route.tangent = true;
      placeRoute(link);
      if (curveClear(route.start, route.controls, route.end, obstacles)) continue;
      route.tangent = false;
    }
    route.curvature = routeLink(start, end, obstacles);
    placeRoute(link);
  }
  return bundles;
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

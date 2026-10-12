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
  const forbidden = [];
  for (const { x, y, r } of obstacles) {
    const along = (x - start.x) * ux + (y - start.y) * uy;
    // force-graph's perpendicular is (uy, -ux): the direction of angle - 90°.
    const across = (x - start.x) * uy - (y - start.y) * ux;
    const ranges = [];
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
    if (ranges.length > 0) forbidden.push(ranges);
  }
  if (forbidden.length === 0) return 0;

  const limit = MAX_CURVATURE * length;
  const candidates = [0, ...forbidden.flat(2)];
  const inside = (d, [low, high]) => d > low && d < high;
  let best = 0;
  let bestHits = Infinity;
  for (const d of candidates) {
    if (Math.abs(d) > limit) continue;
    const hits = forbidden.filter((ranges) => ranges.some((range) => inside(d, range))).length;
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
function makeBundle(node, cluster, outgoing, obstacles, radius, clearance) {
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
  for (const other of obstacles) {
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
    direction: { x: ux, y: uy },
    junction: { x: node.x + ux * reach, y: node.y + uy * reach },
    links: cluster.map((entry) => entry.link),
  };
}

/**
 * Lays out every visible link: bundles links that leave a node close together (see
 * BUNDLE_ANGLE), then bends each link's free part around the circles in `nodes`.
 *
 * Sets `link.route = { start, controls, end, sourceBundle, targetBundle }` on each visible
 * link: the free part is a Bézier curve from `start` to `end` (a bundle's junction, or the
 * node itself) through `controls` (none for a straight line, one for quadratic, two for
 * cubic), and the bundles' trunks join it to the nodes. A branch leaves its junction along
 * the trunk when that curve is clear; otherwise it bends around circles like any other link. Returns the bundles. `radius(node)` gives a
 * node's radius; `clearance` is the gap kept around each circle.
 */
export function layoutLinks(links, nodes, radius, clearance, isVisible = () => true) {
  const placed = nodes.filter((node) => node.x != null);
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
      const bundle = makeBundle(node, cluster, outgoing, placed, radius, clearance);
      if (!bundle) continue;
      bundles.push(bundle);
      for (const link of bundle.links)
        link.route[outgoing ? 'sourceBundle' : 'targetBundle'] = bundle;
    }
  }

  for (const link of visible) {
    const { route, source, target } = link;
    const { sourceBundle, targetBundle } = route;
    route.start = sourceBundle?.junction ?? source;
    route.end = targetBundle?.junction ?? target;
    const obstacles = obstaclesNear(
      route.start,
      route.end,
      placed,
      [source, target],
      radius,
      clearance,
    );
    if (sourceBundle || targetBundle) {
      const length = Math.hypot(route.end.x - route.start.x, route.end.y - route.start.y);
      const along = (bundle, end) =>
        bundle
          ? {
              x: end.x + bundle.direction.x * BRANCH_TANGENT * length,
              y: end.y + bundle.direction.y * BRANCH_TANGENT * length,
            }
          : end;
      const controls = [along(sourceBundle, route.start), along(targetBundle, route.end)];
      if (curveClear(route.start, controls, route.end, obstacles)) {
        route.controls = controls;
        continue;
      }
    }
    const curvature = routeLink(route.start, route.end, obstacles);
    route.controls = curvature ? [controlPoint(route.start, route.end, curvature)] : [];
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
function obstaclesNear(start, end, nodes, skip, radius, clearance) {
  const minX = Math.min(start.x, end.x);
  const maxX = Math.max(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const maxY = Math.max(start.y, end.y);
  const reach = MAX_CURVATURE * Math.hypot(end.x - start.x, end.y - start.y) * 0.5;
  const obstacles = [];
  for (const node of nodes) {
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

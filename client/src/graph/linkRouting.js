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

/**
 * Sets `link.curvature` on every link so it bends around the other circles in `nodes`.
 * `radius(node)` gives a node's radius; `margin` is the extra clearance around each circle.
 * Nodes not yet positioned, and links `isVisible` rejects, are skipped.
 */
export function routeLinks(links, nodes, radius, margin, isVisible = () => true) {
  const placed = nodes.filter((node) => node.x != null);
  for (const link of links) {
    const { source, target } = link;
    if (typeof source !== 'object' || source.x == null || target.x == null || !isVisible(link)) {
      link.curvature = 0;
      continue;
    }
    const minX = Math.min(source.x, target.x);
    const maxX = Math.max(source.x, target.x);
    const minY = Math.min(source.y, target.y);
    const maxY = Math.max(source.y, target.y);
    const reach = MAX_CURVATURE * Math.hypot(target.x - source.x, target.y - source.y) * 0.5;
    const obstacles = [];
    for (const node of placed) {
      if (node === source || node === target) continue;
      const r = radius(node) + margin;
      // Skip circles outside the area any allowed curve could pass through.
      if (
        node.x + r < minX - reach ||
        node.x - r > maxX + reach ||
        node.y + r < minY - reach ||
        node.y - r > maxY + reach
      )
        continue;
      obstacles.push({ x: node.x, y: node.y, r });
    }
    link.curvature = routeLink(source, target, obstacles);
  }
}

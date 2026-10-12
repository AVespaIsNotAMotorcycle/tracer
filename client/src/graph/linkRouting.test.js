import { describe, expect, it } from 'vitest';
import {
  controlPoint,
  layoutLinks,
  MAX_CURVATURE,
  placeLinks,
  pointOnCurve,
  routeLink,
} from './linkRouting.js';

/** Smallest distance from (x, y) to force-graph's curve for a link with this curvature. */
function distanceToCurve(start, end, curvature, { x, y }) {
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  const a = Math.atan2(end.y - start.y, end.x - start.x);
  const d = length * curvature;
  const cp = {
    x: (start.x + end.x) / 2 + d * Math.cos(a - Math.PI / 2),
    y: (start.y + end.y) / 2 + d * Math.sin(a - Math.PI / 2),
  };
  let min = Infinity;
  for (let i = 0; i <= 1000; i++) {
    const t = i / 1000;
    const px = (1 - t) ** 2 * start.x + 2 * t * (1 - t) * cp.x + t ** 2 * end.x;
    const py = (1 - t) ** 2 * start.y + 2 * t * (1 - t) * cp.y + t ** 2 * end.y;
    min = Math.min(min, Math.hypot(px - x, py - y));
  }
  return min;
}

const start = { x: 0, y: 0 };
const end = { x: 100, y: 0 };

describe('routeLink', () => {
  it('keeps a link straight when nothing is in the way', () => {
    expect(routeLink(start, end, [{ x: 50, y: 40, r: 10 }])).toBe(0);
  });

  it.each([
    { x: 50, y: 0 },
    { x: 50, y: 4 },
    { x: 30, y: -6 },
  ])('bends around a circle at (%o)', (center) => {
    const obstacle = { ...center, r: 10 };
    const curvature = routeLink(start, end, [obstacle]);
    expect(curvature).not.toBe(0);
    expect(distanceToCurve(start, end, curvature, obstacle)).toBeGreaterThan(10 - 0.2);
  });

  it('bends toward the side with more room', () => {
    // Circle just below the line (+y): the curve should pass above it (-y).
    const curvature = routeLink(start, end, [{ x: 50, y: 4, r: 10 }]);
    const a = Math.atan2(end.y - start.y, end.x - start.x);
    expect(Math.sin(a - Math.PI / 2) * curvature).toBeLessThan(0);
  });

  it('clears several circles at once', () => {
    const obstacles = [
      { x: 40, y: 0, r: 8 },
      { x: 60, y: -14, r: 8 },
    ];
    const curvature = routeLink(start, end, obstacles);
    for (const o of obstacles) {
      expect(distanceToCurve(start, end, curvature, o)).toBeGreaterThan(o.r - 0.2);
    }
  });

  it('always finds a bend crossing the fewest circles (randomized, against brute force)', () => {
    // The router's model, checked the slow way: each circle forbids bends in a few open
    // ranges (one per slice across it), and a bend crosses it if any range contains it.
    const SLICES = 9;
    const length = 100;
    const forbidden = (o) => {
      const ranges = [];
      for (let i = 0; i < SLICES; i++) {
        const offset = o.r * ((2 * i) / (SLICES - 1) - 1);
        const t = (o.x + offset) / length;
        if (t <= 0 || t >= 1) continue;
        const k = 2 * t * (1 - t);
        const half = Math.sqrt(o.r ** 2 - offset ** 2);
        // routeLink measures across as (y - start.y)·(-1) here, since the chord runs along +x.
        ranges.push([(-o.y - half) / k, (-o.y + half) / k]);
      }
      return ranges;
    };
    // Within 1e-9 of a range end counts as touching: curvature × length rounds.
    const crossed = (d, all) =>
      all.filter((ranges) => ranges.some(([low, high]) => low + 1e-9 < d && d < high - 1e-9))
        .length;

    let seed = 1;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let trial = 0; trial < 200; trial++) {
      const obstacles = Array.from({ length: 1 + Math.floor(random() * 8) }, () => ({
        x: 5 + random() * 90,
        y: -40 + random() * 80,
        r: 3 + random() * 15,
      }));
      const all = obstacles.map(forbidden);
      const limit = MAX_CURVATURE * length;
      const candidates = [0, -limit, limit, ...all.flat(2)].filter((d) => Math.abs(d) <= limit);
      for (let d = -limit; d <= limit; d += 0.1) candidates.push(d);
      const fewest = Math.min(...candidates.map((d) => crossed(d, all)));

      const chosen = routeLink(start, end, obstacles) * length;
      expect(Math.abs(chosen)).toBeLessThanOrEqual(limit + 1e-9);
      expect(crossed(chosen, all)).toBe(fewest);
    }
  });

  it('never bends past MAX_CURVATURE', () => {
    const wall = [-60, -40, -20, 0, 20, 40, 60].map((y) => ({ x: 50, y, r: 12 }));
    expect(Math.abs(routeLink(start, end, wall))).toBeLessThanOrEqual(MAX_CURVATURE);
  });
});

describe('controlPoint', () => {
  it('matches force-graph: perpendicular to the chord, at angle - 90°', () => {
    const a = { x: 3, y: 4 };
    const b = { x: 53, y: -16 };
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const cp = controlPoint(a, b, 0.3);
    expect(cp.x).toBeCloseTo((a.x + b.x) / 2 + 0.3 * length * Math.cos(angle - Math.PI / 2));
    expect(cp.y).toBeCloseTo((a.y + b.y) / 2 + 0.3 * length * Math.sin(angle - Math.PI / 2));
  });
});

const node = (id, x, y) => ({ id, x, y });
const radius = () => 5;

describe('layoutLinks', () => {
  it('ignores the link’s own ends and hidden links', () => {
    const a = node('a', 0, 0);
    const b = node('b', 100, 0);
    const c = node('c', 50, 0);
    const link = { source: a, target: b };
    layoutLinks([link], [a, b], radius, 2);
    expect(link.route.controls).toEqual([]);
    layoutLinks([link], [a, b, c], radius, 2, () => false);
    expect(link.route).toBeNull();
    layoutLinks([link], [a, b, c], radius, 2);
    expect(link.route.controls).toHaveLength(1);
  });

  it('finds circles whose centers lie in grid cells beyond the link but reach into it', () => {
    const a = node('a', 0, 0);
    const b = node('b', 400, 0);
    // Centered well off the line (and in another grid cell), but big enough to cover it.
    // Its cell is beyond the link's box; only padding the box by the largest radius finds it.
    const big = node('big', 200, 260);
    const sizes = new Map([[big, 270]]);
    const link = { source: a, target: b };
    // Fill the rest of the graph so the grid is used rather than a full scan.
    const filler = Array.from({ length: 200 }, (_, i) => node(`f${i}`, 5000 + i * 100, 5000));
    layoutLinks([link], [a, b, big, ...filler], (n) => sizes.get(n) ?? 5, 2);
    expect(link.route.controls).toHaveLength(1);
  });

  it('moves planned routes with their nodes, keeping bends and bundles', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -10);
    const q = node('q', 200, 10);
    const block = node('block', 100, 105); // On the lone → q line.
    const lone = node('lone', 0, 200);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
      { source: lone, target: q },
    ];
    const bundles = layoutLinks(links, [hub, p, q, block, lone], radius, 2);
    const bent = links[2].route.curvature;
    expect(bent).not.toBe(0);

    // Everything shifts; placing (not re-planning) follows it.
    for (const n of [hub, p, q, block, lone]) {
      n.x += 50;
      n.y += 30;
    }
    placeLinks(links, bundles);

    expect(bundles[0].junction.x).toBeCloseTo(50 + bundles[0].reach);
    expect(links[0].route.start).toBe(bundles[0].junction);
    expect(links[0].route.end).toBe(p);
    expect(links[2].route.curvature).toBe(bent);
    expect(links[2].route.controls[0]).toEqual(controlPoint(lone, q, bent));
  });

  it('bundles links leaving a node in nearly the same direction', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -10);
    const q = node('q', 200, 10);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    const bundles = layoutLinks(links, [hub, p, q], radius, 2);
    expect(bundles).toHaveLength(1);
    const [bundle] = bundles;
    expect(bundle).toMatchObject({ node: hub, outgoing: true });
    expect(bundle.junction.x).toBeGreaterThan(20);
    expect(bundle.junction.x).toBeLessThanOrEqual(0.6 * Math.hypot(200, 10) + 1e-9);
    expect(Math.abs(bundle.junction.y)).toBeLessThan(1e-9);
    for (const link of links) {
      expect(link.route.sourceBundle).toBe(bundle);
      expect(link.route.start).toBe(bundle.junction);
      expect(link.route.end).toBe(link.target);
    }
  });

  it('starts branches along the trunk, so they merge smoothly', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -30);
    const q = node('q', 200, 30);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    const [bundle] = layoutLinks(links, [hub, p, q], radius, 2);
    for (const { route } of links) {
      expect(route.controls).toHaveLength(2);
      // The first control point lies on the trunk's line, beyond the junction.
      const [first] = route.controls;
      const across =
        (first.x - hub.x) * bundle.direction.y - (first.y - hub.y) * bundle.direction.x;
      expect(across).toBeCloseTo(0);
      expect(first.x).toBeGreaterThan(bundle.junction.x);
    }
  });

  it('bends a branch around a circle instead when the smooth curve would cross it', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -10);
    const q = node('q', 200, 10);
    const block = node('block', 140, -7);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    layoutLinks(links, [hub, p, q, block], radius, 2);
    const { route } = links[0];
    for (let i = 0; i <= 50; i++) {
      const point = pointOnCurve(route.start, route.controls, route.end, i / 50);
      expect(Math.hypot(point.x - block.x, point.y - block.y)).toBeGreaterThan(7 - 0.3);
    }
  });

  it('leaves out a short link that would cut the trunk short', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 400, -10);
    const q = node('q', 400, 10);
    const near = node('near', 40, 10); // Close to the hub, just beside the trunk's line.
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
      { source: hub, target: near },
    ];
    const [bundle] = layoutLinks(links, [hub, p, q, near], radius, 2);
    expect(bundle.links).toEqual(links.slice(0, 2));
    expect(links[2].route.sourceBundle).toBeNull();
    // Long enough to pass the left-out link's node.
    expect(bundle.reach).toBeGreaterThan(100);
  });

  it('turns the trunk within its links’ angles to pass a circle in its way', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 400, -60);
    const q = node('q', 400, 60);
    const block = node('block', 60, 0); // Right on the mean direction.
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    const [bundle] = layoutLinks(links, [hub, p, q, block], radius, 2);
    expect(bundle.reach).toBeGreaterThan(60);
    expect(Math.abs(bundle.direction.y)).toBeGreaterThan(0.05);

    // The turn is kept relative to the links as they move.
    for (const n of [hub, p, q, block]) n.y += 25;
    const direction = { ...bundle.direction };
    placeLinks(links, [bundle]);
    expect(bundle.direction.x).toBeCloseTo(direction.x);
    expect(bundle.direction.y).toBeCloseTo(direction.y);
  });

  it('bundles incoming links at their shared target', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', -200, -10);
    const q = node('q', -200, 10);
    const links = [
      { source: p, target: hub },
      { source: q, target: hub },
    ];
    const [bundle] = layoutLinks(links, [hub, p, q], radius, 2);
    expect(bundle).toMatchObject({ node: hub, outgoing: false });
    for (const link of links) expect(link.route.end).toBe(bundle.junction);
  });

  it('keeps links apart when they point different ways or diverge widely', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -10);
    const q = node('q', 200, 10);
    const r = node('r', 0, 200);
    // hub cites p, q cites hub: same direction from hub, but opposite citation directions.
    const mixed = [
      { source: hub, target: p },
      { source: q, target: hub },
      { source: hub, target: r },
    ];
    expect(layoutLinks(mixed, [hub, p, q, r], radius, 2)).toHaveLength(0);
  });

  it('bundles across the ±180° boundary', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', -200, -10);
    const q = node('q', -200, 10);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    expect(layoutLinks(links, [hub, p, q], radius, 2)).toHaveLength(1);
  });

  it('stops the trunk before a circle in its way, or drops it if too short', () => {
    const hub = node('hub', 0, 0);
    const p = node('p', 200, -10);
    const q = node('q', 200, 10);
    const near = node('near', 15, 0);
    const links = [
      { source: hub, target: p },
      { source: hub, target: q },
    ];
    expect(layoutLinks(links, [hub, p, q, near], radius, 2)).toHaveLength(0);
    const far = node('far', 45, 0);
    const [bundle] = layoutLinks(links, [hub, p, q, far], radius, 2);
    expect(bundle.junction.x).toBeCloseTo(45 - 7);
  });
});

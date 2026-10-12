import { describe, expect, it } from 'vitest';
import { MAX_CURVATURE, routeLink, routeLinks } from './linkRouting.js';

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

  it('never bends past MAX_CURVATURE', () => {
    const wall = [-60, -40, -20, 0, 20, 40, 60].map((y) => ({ x: 50, y, r: 12 }));
    expect(Math.abs(routeLink(start, end, wall))).toBeLessThanOrEqual(MAX_CURVATURE);
  });
});

describe('routeLinks', () => {
  it('ignores the link’s own ends and hidden links', () => {
    const a = { id: 'a', x: 0, y: 0 };
    const b = { id: 'b', x: 100, y: 0 };
    const c = { id: 'c', x: 50, y: 0 };
    const own = { source: a, target: b };
    const hidden = { source: a, target: b };
    routeLinks([own], [a, b], () => 10, 2);
    expect(own.curvature).toBe(0);
    routeLinks(
      [hidden],
      [a, b, c],
      () => 10,
      2,
      () => false,
    );
    expect(hidden.curvature).toBe(0);
    routeLinks([own], [a, b, c], () => 10, 2);
    expect(own.curvature).not.toBe(0);
  });
});

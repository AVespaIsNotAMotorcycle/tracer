import { describe, expect, it } from 'vitest';
import { axisGeometry } from './axis.js';

const close = (actual, expected) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

describe('axisGeometry', () => {
  it.each([0, 30, 45, 90])('round-trips (u, v) at %i degrees', (angle) => {
    const g = axisGeometry(angle);
    const { x, y } = g.fromUV(12, -7);
    expect(g.toU(x, y)).toBeCloseTo(12, 10);
    expect(g.toV(x, y)).toBeCloseTo(-7, 10);
  });

  it('runs time left to right when horizontal', () => {
    close(axisGeometry(0).fromUV(10, 0), { x: 10, y: 0 });
  });

  it('runs time top to bottom when vertical (y grows downward)', () => {
    close(axisGeometry(90).fromUV(10, 0), { x: 0, y: 10 });
  });

  it('runs time down and to the right at 30 degrees, shallower than 45', () => {
    const { x, y } = axisGeometry(30).fromUV(10, 0);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(y / x).toBeCloseTo(Math.tan(Math.PI / 6), 10);
  });

  it('points v toward the upper right', () => {
    const { x, y } = axisGeometry(30).fromUV(0, 10);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeLessThan(0);
  });

  it('converts along/across velocity consistently with positions', () => {
    const g = axisGeometry(30);
    const { vx, vy } = g.alongAcross(3, 4);
    close({ x: vx, y: vy }, g.fromUV(3, 4));
  });
});

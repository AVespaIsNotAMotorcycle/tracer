import { describe, expect, it } from 'vitest';
import { connectedComponents, laneCenters } from './lanes.js';

describe('connectedComponents', () => {
  it('groups works linked either way, the anchor’s first, then largest first', () => {
    const links = [
      { source: 'a', target: 'b' },
      { source: 'c', target: 'b' },
      { source: { id: 'x' }, target: { id: 'y' } },
      { source: 'p', target: 'q' },
      { source: 'r', target: 'q' },
      { source: 'q', target: 's' },
    ];
    expect(
      connectedComponents(['a', 'b', 'c', 'x', 'y', 'p', 'q', 'r', 's', 'z'], links, ['x']),
    ).toEqual([['x', 'y'], ['p', 'q', 'r', 's'], ['a', 'b', 'c'], ['z']]);
  });

  it('puts components holding anchors first, in anchor order', () => {
    const links = [
      { source: 'a', target: 'b' },
      { source: 'x', target: 'y' },
      { source: 'p', target: 'q' },
      { source: 'q', target: 'r' },
    ];
    expect(
      connectedComponents(['a', 'b', 'p', 'q', 'r', 'x', 'y', 'z'], links, ['x', 'a']),
    ).toEqual([['x', 'y'], ['a', 'b'], ['p', 'q', 'r'], ['z']]);
  });

  it('ignores links to works not listed', () => {
    expect(connectedComponents(['a', 'b'], [{ source: 'a', target: 'gone' }], ['a'])).toEqual([
      ['a'],
      ['b'],
    ]);
  });
});

describe('laneCenters', () => {
  it('centers the anchor’s component and stacks the others outward, gap apart', () => {
    const extents = [
      { min: -50, max: 50 }, // anchor's, 100 across
      { min: 10, max: 70 }, // above it (center 40 > 0), 60 across
      { min: -40, max: -20 }, // below it, 20 across
      { min: 60, max: 100 }, // above, further out than the second
    ];
    // Above: 50 + 10 + 30 = 90 (top 120), then 120 + 10 + 20 = 150. Below: -50 - 10 - 10.
    expect(laneCenters(extents, 10)).toEqual([0, 90, -70, 150]);
  });

  it('keeps each component on the side of the anchor’s it is on now', () => {
    // The anchor's component has drifted off the axis; sides are relative to its center.
    const extents = [
      { min: 100, max: 200 },
      { min: 120, max: 140 }, // center 130 < 150: below
    ];
    expect(laneCenters(extents, 10)).toEqual([0, -70]);
  });

  it('handles no components', () => {
    expect(laneCenters([], 10)).toEqual([]);
  });
});

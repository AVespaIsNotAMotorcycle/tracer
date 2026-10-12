import { describe, expect, it } from 'vitest';
import { SOURCE_TYPE_KEYS, sourceTypeKey } from './sourceTypeKeys.js';
import { iconPathData, SOURCE_TYPES, sourceType } from './sourceTypes.js';

describe('sourceType', () => {
  it.each([
    ['article', 'Article'],
    ['book', 'Book'],
    ['book-chapter', 'Book chapter'],
    ['book-review', 'Book review'],
    ['review', 'Review article'],
    ['dissertation', 'Dissertation'],
  ])('labels %s as %s', (type, label) => {
    expect(sourceType(type)).toMatchObject({ key: type, label });
  });

  it('gives books, articles, and book reviews distinct icons', () => {
    const icons = ['book', 'article', 'book-review'].map((t) => sourceType(t).Icon);
    expect(new Set(icons).size).toBe(3);
  });

  it.each([null, undefined, '', 'something-new'])('falls back to Other for %s', (type) => {
    expect(sourceType(type)).toMatchObject({ key: 'other', label: 'Other' });
  });

  it('has canvas geometry for every type', () => {
    for (const type of ['article', 'book', 'book-review', 'dataset', 'other']) {
      expect(iconPathData(sourceType(type).shape)).toMatch(/^M/);
    }
  });
});

describe('sourceTypeKeys', () => {
  it('matches the icon mapping exactly', () => {
    expect(Object.keys(SOURCE_TYPES).sort()).toEqual([...SOURCE_TYPE_KEYS].sort());
  });

  it('groups unknown types as other', () => {
    expect(sourceTypeKey('book-review')).toBe('book-review');
    expect(sourceTypeKey('brand-new-type')).toBe('other');
    expect(sourceTypeKey(null)).toBe('other');
  });
});

describe('iconPathData', () => {
  it('passes paths through and joins elements', () => {
    expect(
      iconPathData([
        ['path', { d: 'M1 1L2 2' }],
        ['path', { d: 'M3 3' }],
      ]),
    ).toBe('M1 1L2 2M3 3');
  });

  it('converts lines and polylines', () => {
    expect(iconPathData([['line', { x1: '1', y1: '2', x2: '3', y2: '4' }]])).toBe('M1 2L3 4');
    expect(iconPathData([['polyline', { points: '1 2 3 4 5 6' }]])).toBe('M1 2L3 4L5 6');
    expect(iconPathData([['polygon', { points: '1,2 3,4 5,6' }]])).toBe('M1 2L3 4L5 6Z');
  });

  it('converts circles and ellipses to two arcs', () => {
    expect(iconPathData([['circle', { cx: '12', cy: '12', r: '3' }]])).toBe(
      'M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z',
    );
    expect(iconPathData([['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }]])).toBe(
      'M3 5a9 3 0 1 0 18 0a9 3 0 1 0 -18 0Z',
    );
  });

  it('converts plain and rounded rects', () => {
    expect(iconPathData([['rect', { x: '2', y: '4', width: '20', height: '16' }]])).toBe(
      'M2 4h20v16h-20Z',
    );
    expect(
      iconPathData([['rect', { x: '8', y: '2', width: '8', height: '4', rx: '1', ry: '1' }]]),
    ).toBe('M9 2H15A1 1 0 0 1 16 3V5A1 1 0 0 1 15 6H9A1 1 0 0 1 8 5V3A1 1 0 0 1 9 2Z');
  });
});

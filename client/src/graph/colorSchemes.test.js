import { describe, expect, it } from 'vitest';
import {
  assignFieldColors,
  defaultColorScheme,
  fieldCounts,
  fieldOf,
  workFieldColors,
} from './colorSchemes.js';

const work = (id, topicId, subfield) => ({
  id,
  topic: topicId && {
    id: topicId,
    name: `Topic ${topicId}`,
    subfield: { id: subfield, name: `Subfield ${subfield}` },
    field: { id: 'F', name: 'Social Sciences' },
  },
});

describe('color schemes', () => {
  it('defaults to anchor neighborhoods with several anchors, relation with one', () => {
    expect(defaultColorScheme(1)).toBe('relation');
    expect(defaultColorScheme(2)).toBe('neighborhood');
  });

  it('reads a work’s field at each level', () => {
    expect(fieldOf(work('a', 'T1', 'S1'), 'topic')).toEqual({ key: 'T1', name: 'Topic T1' });
    expect(fieldOf(work('a', 'T1', 'S1'), 'subfield')).toEqual({ key: 'S1', name: 'Subfield S1' });
    expect(fieldOf(work('a', 'T1', 'S1'), 'field')).toEqual({ key: 'F', name: 'Social Sciences' });
    expect(fieldOf(work('a'), 'field')).toBeNull();
  });

  it('colors the most common fields, keeping colors while they stay among them', () => {
    const works = [
      work('a', 'T1', 'S1'),
      work('b', 'T2', 'S1'),
      work('c', 'T3', 'S2'),
      work('d', 'T4', 'S3'),
      work('e'),
    ];
    let colors = assignFieldColors(new Map(), fieldCounts(works, 'subfield'), 2);
    expect([...colors]).toEqual([
      ['S1', 0],
      ['S2', 1],
    ]);
    expect([...workFieldColors(works, 'subfield', colors)]).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 1],
      ['d', 'other'],
      ['e', null],
    ]);

    // S3 overtakes S1: S2 keeps its color, S3 takes the one S1 gave up.
    const more = [
      ...works,
      work('f', 'T5', 'S3'),
      work('g', 'T6', 'S3'),
      work('h', 'T7', 'S2'),
      work('i', 'T8', 'S2'),
    ];
    colors = assignFieldColors(colors, fieldCounts(more, 'subfield'), 2);
    expect([...colors].sort()).toEqual([
      ['S2', 1],
      ['S3', 0],
    ]);
  });
});

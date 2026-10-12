import { describe, expect, it, vi } from 'vitest';
import { createProgressTracker, formatEta } from './progress.js';

describe('createProgressTracker', () => {
  const setup = () => {
    let time = 0;
    const onChange = vi.fn();
    const tracker = createProgressTracker({ label: 'Building graph', onChange, now: () => time });
    return { tracker, onChange, advance: (ms) => (time += ms) };
  };

  it('counts planned and completed requests', () => {
    const { tracker } = setup();
    tracker.plan(4);
    tracker.complete();

    expect(tracker.snapshot()).toMatchObject({ label: 'Building graph', done: 1, total: 4 });
  });

  it('has no time estimate until a request completes', () => {
    const { tracker } = setup();
    tracker.plan(3);

    expect(tracker.snapshot().etaMs).toBeNull();
  });

  it('estimates time remaining from measured request latency and parallelism', () => {
    let time = 0;
    const tracker = createProgressTracker({ label: 'x', parallelism: 2, now: () => time });
    tracker.plan(5);
    const first = tracker.begin();
    time += 1000;
    first(); // 1 s latency.

    // 4 requests left, 1 s each, 2 at a time.
    expect(tracker.snapshot()).toMatchObject({ done: 1, etaMs: 2000 });
  });

  it('ignores skipped requests when estimating latency', () => {
    let time = 0;
    const tracker = createProgressTracker({ label: 'x', now: () => time });
    tracker.plan(4);
    tracker.complete(2); // Skipped instantly.
    expect(tracker.snapshot().etaMs).toBeNull();
    const finish = tracker.begin();
    time += 500;
    finish();

    expect(tracker.snapshot()).toMatchObject({ done: 3, etaMs: 500 });
  });

  it('includes projected requests and marks the total as an estimate', () => {
    const { tracker } = setup();
    tracker.plan(2);
    tracker.project(10);

    expect(tracker.snapshot()).toMatchObject({ total: 12, estimated: true });
    tracker.project(0);
    expect(tracker.snapshot()).toMatchObject({ total: 2, estimated: false });
  });

  it('never reports a total below the completed count', () => {
    const { tracker } = setup();
    tracker.plan(1);
    tracker.complete(3);

    expect(tracker.snapshot().total).toBe(3);
  });

  it('reports works and never expects fewer than already found', () => {
    const { tracker } = setup();
    tracker.setWorks(30, 12.4);
    expect(tracker.snapshot()).toMatchObject({ works: 30, expectedWorks: 30 });
    tracker.setWorks(30, 61.6);
    expect(tracker.snapshot().expectedWorks).toBe(62);
  });

  it('notifies on every change', () => {
    const { tracker, onChange } = setup();
    tracker.plan(1);
    tracker.complete();

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.lastCall[0]).toMatchObject({ done: 1, total: 1 });
  });
});

describe('formatEta', () => {
  it.each([
    [null, 'estimating time…'],
    [800, 'almost done'],
    [8400, 'about 8 s left'],
    [125000, 'about 2 min left'],
  ])('formats %s', (ms, text) => {
    expect(formatEta(ms)).toBe(text);
  });
});

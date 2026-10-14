import { describe, expect, it, vi } from 'vitest';
import { shortestPath } from './pathSearch.js';

/**
 * Lookups over a citation network given as { id: [ids it cites] }, with citation counts.
 * Like the real provider, neighbor lookups report counts only for citing works they return,
 * so the search must ask for the rest. Works in `gone` are named in reference lists but have no
 * record: the provider reports them missing and has no count for them.
 */
function lookups(network, counts = {}, gone = []) {
  const ids = new Set([...Object.keys(network), ...Object.values(network).flat()]);
  const neighbors = vi.fn(async (asked) => {
    const links = new Map();
    const known = new Map();
    for (const id of asked) {
      const citing = [...ids].filter((other) => (network[other] ?? []).includes(id));
      links.set(id, [
        ...(network[id] ?? []).map((other) => ({ id: other, link: 'cites' })),
        ...citing.map((other) => ({ id: other, link: 'cited-by' })),
      ]);
      for (const other of citing) known.set(other, counts[other] ?? 0);
    }
    return { links, counts: known, missing: asked.filter((id) => gone.includes(id)) };
  });
  const citationCounts = vi.fn(
    async (asked) =>
      new Map(asked.filter((id) => !gone.includes(id)).map((id) => [id, counts[id] ?? 0])),
  );
  return { neighbors, citationCounts };
}

const steps = (result) => result.path.map(({ id, link }) => [id, link]);

describe('shortestPath', () => {
  it('finds the shortest chain of citations in either direction', async () => {
    // R cites A; B cites A and X. A longer way: R cites C, C cites D, D cites X.
    const result = await shortestPath(
      'X',
      'R',
      lookups({ R: ['A', 'C'], B: ['A', 'X'], C: ['D'], D: ['X'] }),
    );

    expect(result.outcome).toBe('found');
    expect(steps(result)).toEqual([
      ['X', null],
      ['B', 'cited-by'],
      ['A', 'cites'],
      ['R', 'cited-by'],
    ]);
  });

  it('ends at the nearest of several targets', async () => {
    // X cites A, which cites S. R is further: X cites B, B cites C, C cites R.
    const network = { X: ['A', 'B'], A: ['S'], B: ['C'], C: ['R'] };
    const result = await shortestPath('X', ['R', 'S'], lookups(network));

    expect(result.outcome).toBe('found');
    expect(steps(result)).toEqual([
      ['X', null],
      ['A', 'cites'],
      ['S', 'cites'],
    ]);
  });

  it('breaks ties between shortest paths by total citations', async () => {
    // R cites P and Q, which both cite X.
    const network = { R: ['P', 'Q'], P: ['X'], Q: ['X'] };
    for (const [counts, middle] of [
      [{ P: 5, Q: 50 }, 'Q'],
      [{ P: 50, Q: 5 }, 'P'],
    ]) {
      const result = await shortestPath('X', 'R', lookups(network, counts));
      expect(result.path.map((step) => step.id)).toEqual(['X', middle, 'R']);
    }
  });

  it('weighs every work on a path, not only where the two searches meet', async () => {
    // R–A1–A2–X or R–B1–B2–X. B2 alone is cited more than A2, but A1 and A2 together more
    // than B1 and B2.
    const result = await shortestPath(
      'X',
      'R',
      lookups(
        { R: ['A1', 'B1'], A1: ['A2'], B1: ['B2'], A2: ['X'], B2: ['X'] },
        { A1: 100, A2: 10, B1: 1, B2: 20 },
      ),
    );
    expect(result.path.map((step) => step.id)).toEqual(['X', 'A2', 'A1', 'R']);
  });

  it('weighs works reached two ways at the same distance by their best way', async () => {
    // Three steps either way: X is cited by M1 and M2, both cited by N, which R cites; or X
    // is cited by L, cited by K, which R cites. N's best way back runs through M2, the most
    // cited, which beats the way through K and L.
    const result = await shortestPath(
      'X',
      'R',
      lookups(
        { M1: ['X'], M2: ['X'], N: ['M1', 'M2'], R: ['N', 'K'], K: ['L'], L: ['X'] },
        { M1: 1, M2: 9, N: 1, K: 2, L: 2 },
      ),
    );
    expect(result.path.map((step) => step.id)).toEqual(['X', 'M2', 'N', 'R']);
  });

  it('looks up counts only for works on shortest paths that it doesn’t know', async () => {
    const api = lookups({ R: ['P', 'Q'], P: ['X'], Q: ['X'], Z: ['X'] }, { P: 1, Q: 2 });
    await shortestPath('X', 'R', api);
    // P, Q and Z cite X, so their counts came with the lookup; only the ends are missing.
    expect(api.citationCounts).toHaveBeenCalledWith(expect.arrayContaining(['X', 'R']));
    expect(api.citationCounts.mock.calls[0][0]).not.toContain('Z');
  });

  it('skips works the provider no longer has, finding the next shortest path', async () => {
    // X and R both cite G, which has no record: two steps through G, if it existed. The real
    // path is three: X is cited by P, which is cited by Q, which R cites.
    const result = await shortestPath(
      'X',
      'R',
      lookups({ X: ['G'], R: ['G', 'Q'], P: ['X'], Q: ['P'] }, {}, ['G']),
    );
    expect(result.path.map((step) => step.id)).toEqual(['X', 'P', 'Q', 'R']);
  });

  it('says when nothing links the two', async () => {
    const result = await shortestPath('X', 'R', lookups({ R: ['A'], X: ['Y'] }));
    expect(result).toMatchObject({ path: null, outcome: 'none' });
  });

  it('stops at its limits: steps, works searched and time', async () => {
    // R cites C1 cites C2 ... cites C6 cites X: seven steps.
    const network = { R: ['C1'], C1: ['C2'], C2: ['C3'], C3: ['C4'], C4: ['C5'], C5: ['C6'] };
    network.C6 = ['X'];

    expect(await shortestPath('X', 'R', { ...lookups(network), maxSteps: 4 })).toMatchObject({
      path: null,
      outcome: 'budget',
    });
    expect(await shortestPath('X', 'R', { ...lookups(network), maxWorks: 4 })).toMatchObject({
      path: null,
      outcome: 'budget',
      searched: 4,
    });
    let clock = 0;
    const slow = lookups(network);
    const neighbors = async (ids) => {
      clock += 10;
      return slow.neighbors(ids);
    };
    expect(
      await shortestPath('X', 'R', { ...slow, neighbors, deadline: 25, now: () => clock }),
    ).toMatchObject({ outcome: 'budget', searched: 3 });

    expect((await shortestPath('X', 'R', lookups(network))).path).toHaveLength(8);
  });

  it('reports lists that were cut short', async () => {
    const api = lookups({ R: ['A'], A: ['X'] });
    const neighbors = async (ids) => ({ ...(await api.neighbors(ids)), complete: false });
    const result = await shortestPath('X', 'R', { ...api, neighbors });
    expect(result).toMatchObject({ outcome: 'found', complete: false });
  });
});

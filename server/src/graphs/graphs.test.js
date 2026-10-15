import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/authService.js';
import { createGraphService, SNAPSHOT_TTL_MS, SNAPSHOT_VERSION, stateKey } from './graphService.js';
import { SNAPSHOT_VERSION as CLIENT_SNAPSHOT_VERSION } from '../../../client/src/graph/graphModel.js';
import { GraphSnapshot } from '../models/GraphSnapshot.js';
import { Identity } from '../models/Identity.js';
import { SavedGraph } from '../models/SavedGraph.js';
import { Source } from '../models/Source.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';

let mongo;
let app;
let clock;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(
    [User, Identity, Session, SavedGraph, GraphSnapshot].map((model) => model.init()),
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all(
    [User, Identity, Session, SavedGraph, GraphSnapshot].map((model) => model.deleteMany({})),
  );
  clock = Date.parse('2026-10-01T00:00:00Z');
  app = createApp({
    authService: createAuthService(),
    graphService: createGraphService({ now: () => clock }),
  });
});

/** A signed-in agent (it keeps the session cookie). */
async function signedIn(email = 'historian@example.org') {
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').send({ email, password: 'correct horse' });
  return agent;
}

const state = (overrides = {}) => ({
  anchors: [{ id: 'tracer-anchor', ref: '10.1093/past/50.1.76', title: 'The Moral Economy' }],
  options: { citingDepth: 1, citedDepth: 2, limit: 60, maxNodes: 500 },
  filters: {
    minYear: 1950,
    maxYear: null,
    minConnections: 2,
    excludedTypes: ['dataset'],
    excludedLanguages: ['unknown'],
  },
  view: { axisAngle: 45, pinned: ['tracer-b'], colorScheme: 'field', fieldLevel: 'topic' },
  expanded: ['tracer-a', 'tracer-b'],
  ...overrides,
});

describe('saving and opening graphs', () => {
  it('saves a graph with a unique ID and opens it again', async () => {
    const agent = await signedIn();
    const saved = await agent.post('/api/graphs').send({ name: 'Riots', state: state() });

    expect(saved.status).toBe(201);
    const { graph } = saved.body;
    expect(graph).toMatchObject({
      id: expect.any(String),
      name: 'Riots',
      anchors: [{ id: 'tracer-anchor', ref: '10.1093/past/50.1.76', title: 'The Moral Economy' }],
      options: { citingDepth: 1, citedDepth: 2, limit: 60, maxNodes: 500 },
      filters: {
        minYear: 1950,
        maxYear: null,
        minConnections: 2,
        excludedTypes: ['dataset'],
        excludedLanguages: ['unknown'],
      },
      view: { axisAngle: 45, pinned: ['tracer-b'], colorScheme: 'field', fieldLevel: 'topic' },
      expanded: ['tracer-a', 'tracer-b'],
      annotations: [],
    });

    const opened = await agent.get(`/api/graphs/${graph.id}`);
    expect(opened.body.graph).toEqual({ ...graph, snapshot: null });
    const other = await agent.post('/api/graphs').send({ state: state() });
    expect(other.body.graph.id).not.toBe(graph.id);
  });

  it('names a graph after its anchor when no name is given', async () => {
    const agent = await signedIn();
    const { body } = await agent.post('/api/graphs').send({ name: '   ', state: state() });
    expect(body.graph.name).toBe('The Moral Economy');
  });

  it('lists saved graphs, most recently changed first, without their contents', async () => {
    const agent = await signedIn();
    const first = (await agent.post('/api/graphs').send({ name: 'First', state: state() })).body;
    await agent.post('/api/graphs').send({ name: 'Second', state: state() });
    await agent.patch(`/api/graphs/${first.graph.id}`).send({ name: 'First, renamed' });

    const { graphs } = (await agent.get('/api/graphs')).body;
    expect(graphs.map((g) => g.name)).toEqual(['First, renamed', 'Second']);
    expect(graphs[0]).toEqual({
      id: first.graph.id,
      name: 'First, renamed',
      anchors: [{ title: 'The Moral Economy', ref: '10.1093/past/50.1.76' }],
      expandedCount: 2,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('replaces a saved graph’s contents, keeping its ID', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ name: 'Riots', state: state() }))
      .body;
    const updated = await agent
      .put(`/api/graphs/${graph.id}`)
      .send({ state: state({ expanded: ['tracer-c'] }) });

    expect(updated.status).toBe(200);
    expect(updated.body.graph).toMatchObject({
      id: graph.id,
      name: 'Riots',
      expanded: ['tracer-c'],
    });
  });

  it('saves notes on works with the graph, replacing them on update', async () => {
    const agent = await signedIn();
    const note = (workId, body) => ({ target: { type: 'work', workId }, kind: 'note', body });
    const { graph } = (
      await agent.post('/api/graphs').send({
        state: state({
          annotations: [note('tracer-a', 'Riots as protest'), note('tracer-b', '  ')],
        }),
      })
    ).body;
    expect(graph.annotations).toEqual([
      {
        id: expect.any(String),
        target: { type: 'work', workId: 'tracer-a' },
        kind: 'note',
        body: 'Riots as protest',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
    ]);

    // Without annotations, an update keeps them.
    const kept = (await agent.put(`/api/graphs/${graph.id}`).send({ state: state() })).body;
    expect(kept.graph.annotations).toEqual(graph.annotations);

    const updated = (
      await agent.put(`/api/graphs/${graph.id}`).send({
        state: state({
          annotations: [note('tracer-a', 'Riots as protest'), note('tracer-c', 'Compare')],
        }),
      })
    ).body;
    expect(updated.graph.annotations).toMatchObject([
      { id: graph.annotations[0].id, body: 'Riots as protest' },
      { target: { type: 'work', workId: 'tracer-c' }, body: 'Compare' },
    ]);

    const cleared = (
      await agent.put(`/api/graphs/${graph.id}`).send({ state: state({ annotations: [] }) })
    ).body;
    expect(cleared.graph.annotations).toEqual([]);
  });

  it('deletes a saved graph', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ state: state() })).body;
    expect((await agent.delete(`/api/graphs/${graph.id}`)).status).toBe(204);
    expect((await agent.get(`/api/graphs/${graph.id}`)).status).toBe(404);
    expect((await agent.get('/api/graphs')).body.graphs).toEqual([]);
  });
});

// A built graph as the client serializes it (serializeGraph).
const snapshot = (overrides = {}) => ({
  version: SNAPSHOT_VERSION,
  anchorIds: ['tracer-anchor'],
  works: [
    { id: 'tracer-anchor', title: 'The Moral Economy', year: 1971, references: ['tracer-a'] },
    { id: 'tracer-a', title: 'Riots', year: 1960, references: [], abstract: 'x'.repeat(50_000) },
  ],
  relations: [
    ['tracer-anchor', 'anchor'],
    ['tracer-a', 'cited'],
  ],
  expanded: [['tracer-anchor', ['citing', 'cited']]],
  sticky: ['tracer-a'],
  truncated: false,
  ...overrides,
});

describe('color schemes', () => {
  it('refuses an unknown color scheme or field level', async () => {
    const agent = await signedIn();
    const post = (view) => agent.post('/api/graphs').send({ state: state({ view }) });
    expect((await post({ colorScheme: 'rainbow' })).status).toBe(400);
    expect((await post({ colorScheme: 'field', fieldLevel: 'domain' })).status).toBe(400);
    expect((await post({ colorScheme: 'neighborhood' })).status).toBe(201);
  });
});

describe('works merged since saving', () => {
  it('follows merged works to the work they were merged into, dropping the snapshot', async () => {
    const [kept, merged] = await Source.create([{ externalIds: {} }, { externalIds: {} }]);
    const [keptId, mergedId] = [String(kept._id), String(merged._id)];
    const agent = await signedIn();
    const { graph } = (
      await agent.post('/api/graphs').send({
        state: state({
          anchors: [
            { id: mergedId, title: 'Duplicate' },
            { id: keptId, title: 'Original' },
          ],
          view: { axisAngle: 30, pinned: [mergedId, 'tracer-b'] },
          expanded: [mergedId, keptId],
          annotations: [
            { target: { type: 'work', workId: keptId }, kind: 'note', body: 'First' },
            { target: { type: 'work', workId: mergedId }, kind: 'note', body: 'Second' },
          ],
        }),
        snapshot: snapshot({
          anchorIds: [mergedId, keptId],
          works: [{ id: mergedId }, { id: keptId }],
        }),
      })
    ).body;
    await Source.updateOne({ _id: merged._id }, { $set: { mergedInto: kept._id } });

    const opened = (await agent.get(`/api/graphs/${graph.id}`)).body.graph;
    expect(opened).toMatchObject({
      anchors: [{ id: keptId, title: 'Duplicate' }],
      view: { pinned: [keptId, 'tracer-b'] },
      expanded: [keptId],
      snapshot: null,
      updatedAt: graph.updatedAt,
    });
    expect(opened.annotations.map((a) => [a.target.workId, a.body])).toEqual([
      [keptId, 'First\n\nSecond'],
    ]);
    // Rewritten for good, so a snapshot of the rebuild matches its state.
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.stateKey).toBe(opened.stateKey);
  });

  it('drops a snapshot holding a work merged since', async () => {
    const [kept, merged] = await Source.create([{ externalIds: {} }, { externalIds: {} }]);
    const agent = await signedIn();
    const { graph } = (
      await agent.post('/api/graphs').send({
        state: state(),
        snapshot: snapshot({ works: [{ id: 'tracer-anchor' }, { id: String(merged._id) }] }),
      })
    ).body;
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).not.toBeNull();
    await Source.updateOne({ _id: merged._id }, { $set: { mergedInto: kept._id } });
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toBeNull();
  });
});

describe('snapshots of built graphs', () => {
  it('drops a snapshot older than the current shape, so the graph is rebuilt', async () => {
    expect(SNAPSHOT_VERSION).toBe(CLIENT_SNAPSHOT_VERSION);
    const agent = await signedIn();
    // From before snapshots had a version.
    const old = { ...snapshot(), version: undefined };
    const { graph } = (await agent.post('/api/graphs').send({ state: state(), snapshot: old }))
      .body;
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toBeNull();
    expect(await GraphSnapshot.countDocuments({ _id: graph.id })).toBe(0);
  });

  it('opens a graph saved with its snapshot as built, for a week', async () => {
    const agent = await signedIn();
    const { graph } = (
      await agent.post('/api/graphs').send({ state: state(), snapshot: snapshot() })
    ).body;
    expect(graph.snapshot).toBeUndefined();

    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toEqual(snapshot());
    clock += SNAPSHOT_TTL_MS - 1000;
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toEqual(snapshot());
    clock += 2000;
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toBeNull();
  });

  it('stores a snapshot for a graph just rebuilt, refusing one of an older state', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ state: state() })).body;
    const res = await agent
      .put(`/api/graphs/${graph.id}/snapshot`)
      .send({ key: graph.stateKey, snapshot: snapshot() });
    expect(res.status).toBe(204);
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toEqual(snapshot());

    // Saved meanwhile (another tab) with other expansions: a snapshot of the old state is stale.
    const updated = (
      await agent.put(`/api/graphs/${graph.id}`).send({ state: state({ expanded: ['tracer-c'] }) })
    ).body.graph;
    expect(updated.stateKey).not.toBe(graph.stateKey);
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toBeNull();
    const stale = await agent
      .put(`/api/graphs/${graph.id}/snapshot`)
      .send({ key: graph.stateKey, snapshot: snapshot() });
    expect(stale.status).toBe(409);
  });

  it('keeps the snapshot when only the name, filters or view change', async () => {
    const agent = await signedIn();
    const { graph } = (
      await agent.post('/api/graphs').send({ state: state(), snapshot: snapshot() })
    ).body;
    await agent.patch(`/api/graphs/${graph.id}`).send({ name: 'Renamed' });
    await agent
      .put(`/api/graphs/${graph.id}`)
      .send({ state: state({ filters: { minYear: 1900 }, view: { axisAngle: 10 } }) });
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toEqual(snapshot());
  });

  it('replaces the snapshot when updated with one, and deletes it with the graph', async () => {
    const agent = await signedIn();
    const { graph } = (
      await agent.post('/api/graphs').send({ state: state(), snapshot: snapshot() })
    ).body;
    const next = snapshot({ sticky: ['tracer-a', 'tracer-anchor'], truncated: true });
    await agent.put(`/api/graphs/${graph.id}`).send({ state: state(), snapshot: next });
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.snapshot).toEqual(next);

    await agent.delete(`/api/graphs/${graph.id}`);
    expect(await GraphSnapshot.countDocuments()).toBe(0);
  });

  it.each([
    ['of a different anchor', snapshot({ anchorIds: ['tracer-a'] })],
    ['with an extra anchor', snapshot({ anchorIds: ['tracer-anchor', 'tracer-a'] })],
    ['without its anchor’s work', snapshot({ works: [{ id: 'tracer-a' }] })],
    ['with an unknown relation', snapshot({ relations: [['tracer-a', 'sibling']] })],
    ['with an unknown direction', snapshot({ expanded: [['tracer-a', ['sideways']]] })],
  ])('refuses a snapshot %s', async (_, bad) => {
    const agent = await signedIn();
    const res = await agent.post('/api/graphs').send({ state: state(), snapshot: bad });
    expect(res.status).toBe(400);
    expect(await SavedGraph.countDocuments()).toBe(0);
  });

  it('accepts snapshots larger than other requests may be', async () => {
    const agent = await signedIn();
    const big = snapshot({
      works: [
        ...snapshot().works,
        ...Array.from({ length: 300 }, (_, i) => ({ id: `w${i}`, abstract: 'y'.repeat(5000) })),
      ],
    });
    const res = await agent.post('/api/graphs').send({ state: state(), snapshot: big });
    expect(res.status).toBe(201);
    const tooBig = await agent.post('/api/auth/login').send({ email: 'z'.repeat(20_000) });
    expect(tooBig.status).toBe(413);
  });

  it('keeps other users from storing snapshots of a graph', async () => {
    const owner = await signedIn('owner@example.org');
    const other = await signedIn('other@example.org');
    const { graph } = (await owner.post('/api/graphs').send({ state: state() })).body;
    const res = await other
      .put(`/api/graphs/${graph.id}/snapshot`)
      .send({ key: graph.stateKey, snapshot: snapshot() });
    expect(res.status).toBe(404);
    expect(await GraphSnapshot.countDocuments()).toBe(0);
  });
});

describe('access', () => {
  it('requires logging in', async () => {
    const anonymous = request(app);
    expect((await anonymous.get('/api/graphs')).status).toBe(401);
    expect((await anonymous.post('/api/graphs').send({ state: state() })).status).toBe(401);
  });

  it('keeps each user’s graphs to themselves', async () => {
    const owner = await signedIn('owner@example.org');
    const other = await signedIn('other@example.org');
    const { graph } = (await owner.post('/api/graphs').send({ state: state() })).body;

    expect((await other.get(`/api/graphs/${graph.id}`)).status).toBe(404);
    expect((await other.patch(`/api/graphs/${graph.id}`).send({ name: 'Mine' })).status).toBe(404);
    expect((await other.delete(`/api/graphs/${graph.id}`)).status).toBe(404);
    expect((await other.get('/api/graphs')).body.graphs).toEqual([]);
    expect((await owner.get(`/api/graphs/${graph.id}`)).body.graph.name).toBe('The Moral Economy');
  });

  it('refuses changes from another site', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ state: state() })).body;
    const res = await agent.delete(`/api/graphs/${graph.id}`).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  it('saves only within the plan, and keeps graphs openable without it', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ state: state() })).body;
    const override = (planOverrides) => User.updateOne({}, { planOverrides });

    await override({ limits: { savedGraphs: 1 } });
    const full = await agent.post('/api/graphs').send({ state: state() });
    expect(full.status).toBe(403);
    expect(full.body).toEqual({ error: 'You can save up to 1 graphs', limit: 'savedGraphs' });

    await override({ limits: { maxNodes: 100 } });
    const big = await agent.put(`/api/graphs/${graph.id}`).send({ state: state() });
    expect(big.status).toBe(403);
    expect(big.body.limit).toBe('maxNodes');
    const fits = state({ options: { citingDepth: 1, citedDepth: 2, limit: 60, maxNodes: 100 } });
    expect((await agent.put(`/api/graphs/${graph.id}`).send({ state: fits })).status).toBe(200);

    await override({ features: { saveGraphs: false } });
    const refused = await agent.post('/api/graphs').send({ state: state() });
    expect(refused.status).toBe(403);
    expect(refused.body.feature).toBe('saveGraphs');
    expect((await agent.get('/api/graphs')).body.graphs).toHaveLength(1);
    expect((await agent.get(`/api/graphs/${graph.id}`)).status).toBe(200);
    expect((await agent.delete(`/api/graphs/${graph.id}`)).status).toBe(204);
  });

  it('answers 404 for an ID that isn’t one', async () => {
    const agent = await signedIn();
    expect((await agent.get('/api/graphs/not-an-id')).status).toBe(404);
  });
});

describe('several anchors', () => {
  const two = [
    { id: 'tracer-anchor', ref: '10.1093/past/50.1.76', title: 'The Moral Economy' },
    { id: 'tracer-b', ref: 'W2', title: 'Captain Swing' },
  ];

  it('saves and opens a graph with several anchors, named after them', async () => {
    const agent = await signedIn();
    const { graph } = (await agent.post('/api/graphs').send({ state: state({ anchors: two }) }))
      .body;
    expect(graph.name).toBe('The Moral Economy & Captain Swing');
    expect(graph.anchors).toEqual(two);
    expect((await agent.get(`/api/graphs/${graph.id}`)).body.graph.anchors).toEqual(two);
    expect((await agent.get('/api/graphs')).body.graphs[0].anchors).toEqual(
      two.map(({ title, ref }) => ({ title, ref })),
    );
  });

  it('shortens long anchor titles to fit a default name', async () => {
    const agent = await signedIn();
    const long = [
      { id: 'tracer-a', title: 'A'.repeat(100) },
      { id: 'tracer-b', title: 'B'.repeat(100) },
    ];
    const res = await agent.post('/api/graphs').send({ state: state({ anchors: long }) });
    expect(res.status).toBe(201);
    expect(res.body.graph.name).toBe(`${'A'.repeat(57)}… & ${'B'.repeat(57)}…`);
  });

  it('keeps snapshots only for the same anchors, in order', async () => {
    const agent = await signedIn();
    const works = [...snapshot().works, { id: 'tracer-b', references: [] }];
    const built = snapshot({ anchorIds: ['tracer-anchor', 'tracer-b'], works });
    const res = await agent
      .post('/api/graphs')
      .send({ state: state({ anchors: two }), snapshot: built });
    expect(res.status).toBe(201);
    const reversed = snapshot({ anchorIds: ['tracer-b', 'tracer-anchor'], works });
    const refused = await agent
      .post('/api/graphs')
      .send({ state: state({ anchors: two }), snapshot: reversed });
    expect(refused.status).toBe(400);
  });

  it('allows as many anchors as the plan does', async () => {
    const agent = await signedIn();
    const three = [...two, { id: 'tracer-c' }];
    const refused = await agent.post('/api/graphs').send({ state: state({ anchors: three }) });
    expect(refused.status).toBe(403);
    expect(refused.body.limit).toBe('anchors');

    await User.updateOne({}, { plan: 'scholar' });
    expect(
      (await agent.post('/api/graphs').send({ state: state({ anchors: three }) })).status,
    ).toBe(201);
  });

  it('accepts a single `anchor` from an older client', async () => {
    const agent = await signedIn();
    const { anchors, ...rest } = state();
    const res = await agent.post('/api/graphs').send({ state: { ...rest, anchor: anchors[0] } });
    expect(res.status).toBe(201);
    expect(res.body.graph.anchors).toEqual(anchors);
  });

  it('reads a version 1 graph as anchors, with its old state key, and upgrades it on saving', async () => {
    const agent = await signedIn();
    const user = await User.findOne().lean();
    const { anchors, ...rest } = state();
    const old = await SavedGraph.create({
      userId: user._id,
      name: 'Old',
      version: 1,
      anchor: anchors[0],
      ...rest,
    });
    await SavedGraph.updateOne({ _id: old._id }, { $unset: { anchors: 1 } });
    const { citingDepth, citedDepth, limit, maxNodes } = rest.options;
    const v1Key = createHash('sha256')
      .update(
        JSON.stringify([anchors[0].id, citingDepth, citedDepth, limit, maxNodes, rest.expanded]),
      )
      .digest('base64url');

    const opened = (await agent.get(`/api/graphs/${old.id}`)).body.graph;
    expect(opened.anchors).toEqual(anchors);
    expect(opened.stateKey).toBe(v1Key);
    expect(stateKey(state())).toBe(v1Key);
    expect((await agent.get('/api/graphs')).body.graphs[0].anchors).toEqual([
      { title: 'The Moral Economy', ref: '10.1093/past/50.1.76' },
    ]);

    // A legacy snapshot (one anchorId) still applies.
    const legacy = { ...snapshot(), anchorId: 'tracer-anchor' };
    delete legacy.anchorIds;
    const put = await agent
      .put(`/api/graphs/${old.id}/snapshot`)
      .send({ key: v1Key, snapshot: legacy });
    expect(put.status).toBe(204);

    await agent.put(`/api/graphs/${old.id}`).send({ state: state() });
    const stored = await SavedGraph.findById(old._id).lean();
    expect(stored.version).toBe(2);
    expect(stored.anchors).toEqual(anchors);
    expect(stored.anchor).toBeUndefined();
  });
});

describe('validation', () => {
  it.each([
    ['no anchor', state({ anchors: [] })],
    ['an anchor without an ID', state({ anchors: [{ title: 'x' }] })],
    [
      'the same anchor twice',
      state({ anchors: [{ id: 'tracer-anchor' }, { id: 'tracer-anchor' }] }),
    ],
    [
      'a depth out of range',
      state({ options: { citingDepth: 9, citedDepth: 1, limit: 20, maxNodes: 300 } }),
    ],
    ['a non-integer year', state({ filters: { minYear: 'soon' } })],
    ['an axis angle out of range', state({ view: { axisAngle: 120 } })],
    ['pinned works that aren’t IDs', state({ view: { axisAngle: 30, pinned: [7] } })],
    ['expanded works that aren’t IDs', state({ expanded: [{ id: 'x' }] })],
    [
      'a note without a work',
      state({ annotations: [{ target: { type: 'work' }, kind: 'note', body: 'x' }] }),
    ],
    [
      'an overlong note',
      state({
        annotations: [
          { target: { type: 'work', workId: 'tracer-a' }, kind: 'note', body: 'x'.repeat(10_001) },
        ],
      }),
    ],
  ])('refuses a graph with %s', async (_, bad) => {
    const agent = await signedIn();
    expect((await agent.post('/api/graphs').send({ state: bad })).status).toBe(400);
  });

  it('refuses an overlong name', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/graphs').send({ name: 'x'.repeat(121), state: state() });
    expect(res.status).toBe(400);
  });
});

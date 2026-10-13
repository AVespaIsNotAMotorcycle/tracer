import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/authService.js';
import { createGraphService, SNAPSHOT_TTL_MS } from './graphService.js';
import { GraphSnapshot } from '../models/GraphSnapshot.js';
import { Identity } from '../models/Identity.js';
import { SavedGraph } from '../models/SavedGraph.js';
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
  anchor: { id: 'tracer-anchor', ref: '10.1093/past/50.1.76', title: 'The Moral Economy' },
  options: { citingDepth: 1, citedDepth: 2, limit: 60, maxNodes: 500 },
  filters: { minYear: 1950, maxYear: null, minConnections: 2, excludedTypes: ['dataset'] },
  view: { axisAngle: 45 },
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
      anchor: { id: 'tracer-anchor', ref: '10.1093/past/50.1.76', title: 'The Moral Economy' },
      options: { citingDepth: 1, citedDepth: 2, limit: 60, maxNodes: 500 },
      filters: { minYear: 1950, maxYear: null, minConnections: 2, excludedTypes: ['dataset'] },
      view: { axisAngle: 45 },
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
      anchor: { title: 'The Moral Economy', ref: '10.1093/past/50.1.76' },
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
  anchorId: 'tracer-anchor',
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

describe('snapshots of built graphs', () => {
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
    ['of a different anchor', snapshot({ anchorId: 'tracer-a' })],
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

  it('answers 404 for an ID that isn’t one', async () => {
    const agent = await signedIn();
    expect((await agent.get('/api/graphs/not-an-id')).status).toBe(404);
  });
});

describe('validation', () => {
  it.each([
    ['no anchor', state({ anchor: {} })],
    [
      'a depth out of range',
      state({ options: { citingDepth: 9, citedDepth: 1, limit: 20, maxNodes: 300 } }),
    ],
    ['a non-integer year', state({ filters: { minYear: 'soon' } })],
    ['an axis angle out of range', state({ view: { axisAngle: 120 } })],
    ['expanded works that aren’t IDs', state({ expanded: [{ id: 'x' }] })],
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

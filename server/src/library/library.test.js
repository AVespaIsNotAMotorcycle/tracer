import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/authService.js';
import { createGraphService } from '../graphs/graphService.js';
import { Identity } from '../models/Identity.js';
import { LibraryEntry } from '../models/LibraryEntry.js';
import { SavedGraph } from '../models/SavedGraph.js';
import { Session } from '../models/Session.js';
import { Source } from '../models/Source.js';
import { User } from '../models/User.js';
import { createWorkService, RECORD_VERSION } from '../works/workService.js';

const MODELS = [User, Identity, Session, SavedGraph, LibraryEntry, Source];
let mongo;
let app;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(MODELS.map((model) => model.init()));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all(MODELS.map((model) => model.deleteMany({})));
  app = createApp({
    authService: createAuthService(),
    graphService: createGraphService(),
    workService: createWorkService({ provider: { name: 'openalex' } }),
  });
});

async function signedIn(email = 'historian@example.org') {
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').send({ email, password: 'correct horse' });
  return agent;
}

/** A Source with an OpenAlex record, as Tracer stores fetched works. */
async function source(openalex, title, year = 1971) {
  const created = await Source.create({
    externalIds: { openalex },
    records: {
      openalex: {
        data: {
          provider: 'openalex',
          providerId: openalex,
          externalIds: { openalex },
          title,
          authors: [{ name: 'E. P. Thompson', orcid: null }],
          year,
          type: 'article',
          venue: 'Past & Present',
          abstract: null,
          citedByCount: 10,
          referencedIds: [],
          links: [],
          language: 'en',
          topic: null,
        },
        fetchedAt: new Date(),
        version: RECORD_VERSION,
      },
    },
  });
  return String(created._id);
}

describe('reading statuses', () => {
  it('sets, changes and removes a work’s status, for the user only', async () => {
    const id = await source('W1', 'The Moral Economy');
    const agent = await signedIn();
    expect((await agent.put(`/api/library/${id}`).send({ status: 'to-read' })).body).toEqual({
      workId: id,
      status: 'to-read',
    });
    await agent.put(`/api/library/${id}`).send({ status: 'read' });
    expect((await agent.get('/api/library/statuses')).body.statuses).toEqual({ [id]: 'read' });

    const other = await signedIn('other@example.org');
    expect((await other.get('/api/library/statuses')).body.statuses).toEqual({});

    await agent.put(`/api/library/${id}`).send({ status: null });
    expect((await agent.get('/api/library/statuses')).body.statuses).toEqual({});
  });

  it('refuses bad statuses, unknown works, and visitors who aren’t signed in', async () => {
    const id = await source('W1', 'The Moral Economy');
    const agent = await signedIn();
    expect((await agent.put(`/api/library/${id}`).send({ status: 'skimmed' })).status).toBe(400);
    expect((await agent.put('/api/library/not-an-id').send({ status: 'read' })).status).toBe(400);
    const missing = new mongoose.Types.ObjectId().toString();
    expect((await agent.put(`/api/library/${missing}`).send({ status: 'read' })).status).toBe(404);
    expect((await request(app).get('/api/library/statuses')).status).toBe(401);
  });

  it('follows a work merged into another, keeping the most recent status', async () => {
    const kept = await source('W1', 'The Moral Economy');
    const merged = await source('W2', 'The moral economy');
    const agent = await signedIn();
    await agent.put(`/api/library/${kept}`).send({ status: 'to-read' });
    await agent.put(`/api/library/${merged}`).send({ status: 'cited' });
    await Source.updateOne({ _id: merged }, { $set: { mergedInto: kept } });

    expect((await agent.get('/api/library/statuses')).body.statuses).toEqual({ [kept]: 'cited' });
    expect(await LibraryEntry.countDocuments()).toBe(1);
  });
});

describe('GET /api/library', () => {
  it('lists works with a status or a note in any saved graph, with summaries', async () => {
    const read = await source('W1', 'The Moral Economy');
    const noted = await source('W2', 'Whigs and Hunters', 1975);
    const agent = await signedIn();
    await agent.put(`/api/library/${read}`).send({ status: 'read' });
    const { graph } = (
      await agent.post('/api/graphs').send({
        name: 'Riots',
        state: {
          anchors: [{ id: read }],
          options: { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 },
          expanded: [],
          annotations: [
            { target: { type: 'work', workId: noted }, kind: 'note', body: 'On the Black Act' },
          ],
        },
      })
    ).body;

    const { entries } = (await agent.get('/api/library')).body;
    expect(entries).toHaveLength(2);
    const byId = Object.fromEntries(entries.map((entry) => [entry.workId, entry]));
    expect(byId[read]).toMatchObject({
      status: 'read',
      notes: [],
      work: { title: 'The Moral Economy', authors: ['E. P. Thompson'], year: 1971 },
    });
    expect(byId[noted]).toMatchObject({
      status: null,
      notes: [{ graphId: graph.id, graphName: 'Riots', body: 'On the Black Act' }],
      work: { title: 'Whigs and Hunters', year: 1975 },
    });
  });
});

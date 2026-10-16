import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createAuthService } from '../auth/authService.js';
import { Identity } from '../models/Identity.js';
import { LibraryEntry } from '../models/LibraryEntry.js';
import { ManualLink } from '../models/ManualLink.js';
import { ManualWork } from '../models/ManualWork.js';
import { Session } from '../models/Session.js';
import { Source } from '../models/Source.js';
import { User } from '../models/User.js';
import { createWorkService, RECORD_VERSION } from '../works/workService.js';

const MODELS = [User, Identity, Session, Source, ManualWork, ManualLink, LibraryEntry];
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
    workService: createWorkService({ provider: { name: 'openalex' } }),
  });
});

async function signedIn(email = 'historian@example.org') {
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').send({ email, password: 'correct horse' });
  return agent;
}

async function source(openalex, title) {
  const created = await Source.create({
    externalIds: { openalex },
    records: {
      openalex: {
        data: {
          provider: 'openalex',
          providerId: openalex,
          externalIds: { openalex },
          title,
          authors: [],
          year: 1971,
          type: 'article',
          venue: null,
          abstract: null,
          citedByCount: 3,
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

const pamphlet = {
  title: '  An Address to the Journeymen   Weavers ',
  authors: ['Anonymous'],
  year: 1793,
  type: 'other',
};

describe('works added by hand', () => {
  it('creates one, lists it as a manual work for its owner only, and deletes it', async () => {
    const agent = await signedIn();
    const created = await agent.post('/api/manual/works').send(pamphlet);
    expect(created.status).toBe(201);
    expect(created.body.work).toMatchObject({
      title: 'An Address to the Journeymen Weavers',
      authors: [{ name: 'Anonymous', orcid: null }],
      year: 1793,
      type: 'other',
      providers: ['manual'],
      manual: true,
    });
    const { works } = (await agent.get('/api/manual')).body;
    expect(works.map((w) => w.id)).toEqual([created.body.work.id]);

    const other = await signedIn('other@example.org');
    expect((await other.get('/api/manual')).body.works).toEqual([]);
    expect((await other.delete(`/api/manual/works/${created.body.work.id}`)).status).toBe(404);

    expect((await agent.delete(`/api/manual/works/${created.body.work.id}`)).status).toBe(204);
    expect((await agent.get('/api/manual')).body.works).toEqual([]);
  });

  it('refuses works without a title, or with a bad year, type or DOI', async () => {
    const agent = await signedIn();
    const post = (fields) => agent.post('/api/manual/works').send({ ...pamphlet, ...fields });
    expect((await post({ title: ' ' })).status).toBe(400);
    expect((await post({ year: 'soon' })).status).toBe(400);
    expect((await post({ type: 'poem' })).status).toBe(400);
    expect((await post({ doi: 'not a doi' })).status).toBe(400);
    expect((await request(app).post('/api/manual/works').send(pamphlet)).status).toBe(401);
  });
});

describe('citations added by hand', () => {
  it('links works on Tracer and the user’s own, with the linked works to show', async () => {
    const thompson = await source('W1', 'The Moral Economy');
    const agent = await signedIn();
    const { work } = (await agent.post('/api/manual/works').send(pamphlet)).body;

    const link = await agent
      .post('/api/manual/links')
      .send({ citingId: thompson, citedId: work.id });
    expect(link.status).toBe(201);
    // Adding it again gives the same link.
    const again = await agent
      .post('/api/manual/links')
      .send({ citingId: thompson, citedId: work.id });
    expect(again.body.link.id).toBe(link.body.link.id);

    const listed = (await agent.get('/api/manual')).body;
    expect(listed.links).toEqual([{ id: link.body.link.id, citingId: thompson, citedId: work.id }]);
    expect(listed.linkedWorks.map((w) => [w.id, w.title])).toEqual([
      [thompson, 'The Moral Economy'],
    ]);

    expect((await agent.delete(`/api/manual/links/${link.body.link.id}`)).status).toBe(204);
    expect((await agent.get('/api/manual')).body.links).toEqual([]);
  });

  it('refuses a work citing itself, unknown works, and other users’ works', async () => {
    const thompson = await source('W1', 'The Moral Economy');
    const agent = await signedIn();
    const other = await signedIn('other@example.org');
    const { work } = (await other.post('/api/manual/works').send(pamphlet)).body;
    const post = (citingId, citedId) => agent.post('/api/manual/links').send({ citingId, citedId });
    expect((await post(thompson, thompson)).status).toBe(400);
    expect((await post(thompson, new mongoose.Types.ObjectId().toString())).status).toBe(404);
    expect((await post(thompson, work.id)).status).toBe(404);
    expect((await post(thompson, 'W1')).status).toBe(400);
  });

  it('deletes a work’s links with it, and follows merged works', async () => {
    const kept = await source('W1', 'The Moral Economy');
    const merged = await source('W2', 'The moral economy');
    const agent = await signedIn();
    const { work } = (await agent.post('/api/manual/works').send(pamphlet)).body;
    await agent.post('/api/manual/links').send({ citingId: merged, citedId: work.id });
    await Source.updateOne({ _id: merged }, { $set: { mergedInto: kept } });
    expect((await agent.get('/api/manual')).body.links[0].citingId).toBe(kept);

    await agent.delete(`/api/manual/works/${work.id}`);
    expect(await ManualLink.countDocuments()).toBe(0);
  });

  it('lets a work added by hand have a reading status', async () => {
    const agent = await signedIn();
    const { work } = (await agent.post('/api/manual/works').send(pamphlet)).body;
    expect((await agent.put(`/api/library/${work.id}`).send({ status: 'read' })).status).toBe(200);
    const [entry] = (await agent.get('/api/library')).body.entries;
    expect(entry.work).toMatchObject({ title: work.title, manual: true });
  });
});

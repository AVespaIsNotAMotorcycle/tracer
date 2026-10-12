import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { Identity } from '../models/Identity.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { createAuthService, SESSION_TTL_MS } from './authService.js';
import { hashPassword, verifyPassword } from './password.js';

let mongo;
let clock;
let api;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([User.init(), Identity.init(), Session.init()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Identity.deleteMany({}), Session.deleteMany({})]);
  clock = new Date('2026-01-01T00:00:00Z');
  const authService = createAuthService({ now: () => clock });
  api = request.agent(createApp({ authService, authOptions: { now: () => clock.getTime() } }));
});

const signUp = (email = 'historian@example.org', password = 'correct horse') =>
  api.post('/api/auth/signup').send({ email, password });
const logIn = (email = 'historian@example.org', password = 'correct horse') =>
  api.post('/api/auth/login').send({ email, password });
const me = async () => (await api.get('/api/auth/me')).body.user;
// State-changing requests must be JSON, logout included.
const logOut = () => api.post('/api/auth/logout').send({});

describe('passwords', () => {
  it('hashes with a salt, and verifies only the right password', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
  });
});

describe('sign up', () => {
  it('creates an account, signs it in, and stores no plain password', async () => {
    const res = await signUp(' Historian@Example.org ');

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(String), email: 'historian@example.org' });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^tracer_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(await me()).toEqual(res.body.user);

    const identity = await Identity.findOne().lean();
    expect(identity).toMatchObject({ provider: 'password', subject: 'historian@example.org' });
    expect(identity.passwordHash).not.toContain('correct horse');
    // The session is stored by the token's hash, not the token.
    const token = cookie.split(';')[0].split('=')[1];
    expect(await Session.exists({ _id: token })).toBeNull();
  });

  it('refuses a taken email, case-insensitively', async () => {
    await signUp();
    const res = await signUp('HISTORIAN@example.org');
    expect(res.status).toBe(409);
  });

  it('checks the email and password', async () => {
    expect((await signUp('not-an-email')).status).toBe(400);
    const short = await signUp('a@example.org', 'short');
    expect(short.status).toBe(400);
    expect(short.body.error).toMatch(/at least 8/);
    expect((await signUp('b@example.org', 'x'.repeat(257))).status).toBe(400);
    expect(await User.countDocuments()).toBe(0);
  });
});

describe('log in and out', () => {
  beforeEach(async () => {
    await signUp();
    expect((await logOut()).status).toBe(204);
  });

  it('logs in with the right password', async () => {
    expect(await me()).toBeNull();
    const res = await logIn('HISTORIAN@example.org');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('historian@example.org');
    expect((await me()).email).toBe('historian@example.org');
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await logIn('historian@example.org', 'wrong horse');
    const unknown = await logIn('nobody@example.org', 'correct horse');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(await me()).toBeNull();
  });

  it('ends the session on logout', async () => {
    await logIn();
    expect(await Session.countDocuments()).toBe(1);
    const res = await logOut();
    expect(res.status).toBe(204);
    expect(res.headers['set-cookie'][0]).toMatch(/tracer_session=;/);
    expect(await Session.countDocuments()).toBe(0);
    expect(await me()).toBeNull();
  });

  it('expires sessions', async () => {
    await logIn();
    clock = new Date(clock.getTime() + SESSION_TTL_MS + 1);
    expect(await me()).toBeNull();
  });

  it('limits repeated login attempts for an account', async () => {
    for (let i = 0; i < 10; i++) expect((await logIn(undefined, 'wrong horse')).status).toBe(401);
    expect((await logIn()).status).toBe(429);
    // After the window, the right password works again.
    clock = new Date(clock.getTime() + 15 * 60 * 1000 + 1);
    expect((await logIn()).status).toBe(200);
  });
});

describe('request checks', () => {
  it('refuses cross-site and non-JSON requests', async () => {
    const crossSite = await api
      .post('/api/auth/signup')
      .set('Origin', 'https://evil.example')
      .send({ email: 'a@example.org', password: 'correct horse' });
    expect(crossSite.status).toBe(403);

    expect((await api.post('/api/auth/logout')).status).toBe(415);
    const form = await api
      .post('/api/auth/login')
      .type('form')
      .send({ email: 'a@example.org', password: 'correct horse' });
    expect(form.status).toBe(415);
  });

  it('accepts a same-origin request', async () => {
    const res = await api
      .post('/api/auth/signup')
      .set('Origin', 'http://127.0.0.1')
      .set('Host', '127.0.0.1')
      .send({ email: 'a@example.org', password: 'correct horse' });
    expect(res.status).toBe(201);
  });
});

describe('without a database connection', () => {
  it('returns 503', async () => {
    await mongoose.disconnect();
    try {
      expect((await api.get('/api/auth/me')).status).toBe(503);
    } finally {
      await mongoose.connect(mongo.getUri());
    }
  });
});

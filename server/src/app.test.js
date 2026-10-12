import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from './app.js';

describe('GET /api/health', () => {
  it('reports ok with a disconnected database when Mongo is not connected', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'disconnected' });
  });
});

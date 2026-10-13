import express from 'express';
import mongoose from 'mongoose';
import { ProviderError } from '../providers/errors.js';
import { HttpError } from './errors.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new HttpError(400, `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

/**
 * Routes under /api/works. `:id` accepts a Tracer ID, an OpenAlex ID, or a DOI. DOIs contain
 * slashes, so clients must URL-encode them (encodeURIComponent).
 *
 * @param {ReturnType<typeof import('./workService.js').createWorkService>} workService
 */
export function createWorksRouter(workService) {
  const router = express.Router();

  // Tracer IDs live in MongoDB, so these routes can't work without it.
  router.use((req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
      throw new HttpError(503, 'Database unavailable');
    }
    next();
  });

  router.get('/', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) throw new HttpError(400, 'q is required');
    res.json({
      works: await workService.searchWorks(query, { limit: parseLimit(req.query.limit) }),
    });
  });

  router.get('/:id', async (req, res) => {
    res.json({ work: await workService.getWork(req.params.id) });
  });

  router.get('/:id/citing', async (req, res) => {
    const limit = parseLimit(req.query.limit);
    res.json({ works: await workService.getCitingWorks(req.params.id, { limit }) });
  });

  router.get('/:id/cited', async (req, res) => {
    const limit = parseLimit(req.query.limit);
    res.json({ works: await workService.getCitedWorks(req.params.id, { limit }) });
  });

  router.get('/:id/match', async (req, res) => {
    res.json({ match: await workService.getCitationMatch(req.params.id) });
  });

  router.get('/:id/archive', async (req, res) => {
    res.json({ items: await workService.getArchiveItems(req.params.id) });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err instanceof ProviderError) {
      console.error(err);
      return err.status === 429
        ? res.status(503).json({ error: 'Citation provider rate limit reached; try again later' })
        : res.status(502).json({ error: 'Citation provider request failed' });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return router;
}

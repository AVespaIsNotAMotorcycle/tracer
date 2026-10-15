import express from 'express';
import mongoose from 'mongoose';
import { loadUser } from '../auth/routes.js';
import { checkLimit, limitFor, requireFeature } from '../entitlements/entitlements.js';
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

/** How many citing or cited works to list: `limit`, within the user's works per node. */
function parseNeighborLimit(req) {
  if (req.query.limit === undefined) {
    return Math.min(DEFAULT_LIMIT, limitFor(req.user, 'perNode'));
  }
  const limit = parseLimit(req.query.limit);
  checkLimit(
    req.user,
    'perNode',
    limit,
    `Your plan allows at most ${limitFor(req.user, 'perNode')} works per node`,
  );
  return limit;
}

const TEXT_FIELDS = ['any', 'title', 'author', 'abstract', 'fulltext'];
const SORTS = ['relevance', 'cited', 'newest', 'oldest'];
const MAX_TEXT = 300;
const MAX_IDS = 20;
// Works a path search can end at: as many as a graph can have anchors.
const MAX_PATH_TARGETS = 6;
// OpenAlex pages through at most the first 10,000 results.
const MAX_RESULT = 10000;
const ID_LIST = /^[A-Za-z]\d{1,15}(?:,[A-Za-z]\d{1,15})*$/;
const TYPE_LIST = /^[a-z-]{1,40}(?:,[a-z-]{1,40})*$/;

const single = (value) => (typeof value === 'string' ? value.trim() : '');

function parseInteger(value, name, min, max) {
  const text = single(value);
  if (!text) return undefined;
  const number = Number(text);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function parseList(value, name, pattern) {
  const text = single(value);
  if (!text) return undefined;
  if (!pattern.test(text)) throw new HttpError(400, `${name} is not a valid list`);
  const items = [...new Set(text.split(','))];
  if (items.length > MAX_IDS) throw new HttpError(400, `${name} may list at most ${MAX_IDS}`);
  return items;
}

/**
 * The criteria of an advanced search from its query string (see SearchCriteria). At least one
 * field must narrow it; options like sort alone don't.
 *
 * @returns {import('../providers/types.js').SearchCriteria}
 */
export function parseCriteria(query) {
  const criteria = {};
  for (const field of TEXT_FIELDS) {
    const text = single(query[field]).replace(/\s+/g, ' ');
    if (text.length > MAX_TEXT) throw new HttpError(400, `${field} is too long`);
    if (text) criteria[field] = text;
  }
  const venueIds = parseList(query.venue, 'venue', ID_LIST);
  if (venueIds) criteria.venueIds = venueIds;
  const publisherIds = parseList(query.publisher, 'publisher', ID_LIST);
  if (publisherIds) criteria.publisherIds = publisherIds;
  const fromYear = parseInteger(query.fromYear, 'fromYear', -5000, 3000);
  if (fromYear !== undefined) criteria.fromYear = fromYear;
  const toYear = parseInteger(query.toYear, 'toYear', -5000, 3000);
  if (toYear !== undefined) criteria.toYear = toYear;
  if (fromYear !== undefined && toYear !== undefined && fromYear > toYear) {
    throw new HttpError(400, 'fromYear must not be after toYear');
  }
  const types = parseList(query.types, 'types', TYPE_LIST);
  if (types) criteria.types = types;
  const language = single(query.language).toLowerCase();
  if (language) {
    if (!/^[a-z]{2}$/.test(language)) throw new HttpError(400, 'language must be a 2-letter code');
    criteria.language = language;
  }
  const minCitations = parseInteger(query.minCitations, 'minCitations', 0, 1_000_000);
  if (minCitations) criteria.minCitations = minCitations;
  if (single(query.openAccess) === 'true') criteria.openAccess = true;
  if (Object.keys(criteria).length === 0) {
    throw new HttpError(400, 'Give at least one field to search');
  }
  const sort = single(query.sort);
  if (sort) {
    if (!SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${SORTS.join(', ')}`);
    criteria.sort = sort;
  }
  return criteria;
}

/**
 * Routes under /api/works. `:id` accepts a Tracer ID, an OpenAlex ID, or a DOI. DOIs contain
 * slashes, so clients must URL-encode them (encodeURIComponent).
 *
 * Works routes are open to anyone, but some are gated by plan (see entitlements), so the
 * signed-in user, if any, is loaded as `req.user` (null without `authService`, as in tests).
 *
 * @param {ReturnType<typeof import('./workService.js').createWorkService>} workService
 * @param {ReturnType<typeof import('../auth/authService.js').createAuthService>} [authService]
 */
export function createWorksRouter(workService, authService) {
  const router = express.Router();

  // Tracer IDs live in MongoDB, so these routes can't work without it.
  router.use((req, res, next) => {
    if (mongoose.connection.readyState !== 1) {
      throw new HttpError(503, 'Database unavailable');
    }
    next();
  });

  if (authService) router.use(loadUser(authService));
  else {
    router.use((req, res, next) => {
      req.user = null;
      next();
    });
  }

  router.get('/', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) throw new HttpError(400, 'q is required');
    res.json({
      works: await workService.searchWorks(query, { limit: parseLimit(req.query.limit) }),
    });
  });

  // Before /:id, which would take "search" and "suggest" for work IDs.
  router.get('/search', requireFeature('advancedSearch'), async (req, res) => {
    const criteria = parseCriteria(req.query);
    const limit = parseLimit(req.query.limit);
    const page = parseInteger(req.query.page, 'page', 1, Math.floor(MAX_RESULT / limit)) ?? 1;
    res.json(await workService.advancedSearch(criteria, { limit, page }));
  });

  router.get('/suggest/:kind', async (req, res) => {
    const { kind } = req.params;
    if (kind !== 'venue' && kind !== 'publisher') {
      throw new HttpError(404, `Nothing to suggest for ${kind}`);
    }
    const query = single(req.query.q);
    if (!query) throw new HttpError(400, 'q is required');
    if (query.length > MAX_TEXT) throw new HttpError(400, 'q is too long');
    res.json({ suggestions: await workService.suggest(kind, query) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ work: await workService.getWork(req.params.id) });
  });

  router.get('/:id/citing', async (req, res) => {
    const limit = parseNeighborLimit(req);
    res.json({ works: await workService.getCitingWorks(req.params.id, { limit }) });
  });

  router.get('/:id/cited', async (req, res) => {
    const limit = parseNeighborLimit(req);
    res.json({ works: await workService.getCitedWorks(req.params.id, { limit }) });
  });

  router.get('/:id/match', async (req, res) => {
    res.json(await workService.getCitationMatch(req.params.id));
  });

  // `to` is one work or several, comma-separated (a graph's anchors): the path ends at the
  // nearest.
  router.get('/:id/path', requireFeature('pathSearch'), async (req, res) => {
    const to = [
      ...new Set(
        single(req.query.to)
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (to.length === 0) throw new HttpError(400, 'to is required');
    if (to.length > MAX_PATH_TARGETS) {
      throw new HttpError(400, `to may list at most ${MAX_PATH_TARGETS} works`);
    }
    res.json(await workService.findPath(req.params.id, to));
  });

  router.get('/:id/authors', async (req, res) => {
    res.json({ authors: await workService.getAuthorNames(req.params.id) });
  });

  router.get('/:id/archive', async (req, res) => {
    res.json({ items: await workService.getArchiveItems(req.params.id) });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  router.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json(err.body());
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

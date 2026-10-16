import express from 'express';
import { jsonErrors, requireUser, sessionRequestChecks } from '../auth/routes.js';
import { requireFeature } from '../entitlements/entitlements.js';

/**
 * Routes under /api/library, for the signed-in user's own library (see libraryService.js):
 * GET / lists it ({ entries }); GET /statuses gives every reading status ({ statuses:
 * { [workId]: status } }); PUT /:workId sets one ({ status }, null to remove it). All need
 * the `library` feature.
 *
 * @param {ReturnType<typeof import('./libraryService.js').createLibraryService>} libraryService
 * @param {ReturnType<typeof import('../auth/authService.js').createAuthService>} authService
 */
export function createLibraryRouter(libraryService, authService) {
  const router = express.Router();
  router.use(sessionRequestChecks());
  router.use(requireUser(authService));
  router.use(requireFeature('library'));

  router.get('/', async (req, res) => {
    res.json({ entries: await libraryService.list(req.user.id) });
  });

  router.get('/statuses', async (req, res) => {
    res.json({ statuses: await libraryService.statuses(req.user.id) });
  });

  router.put('/:workId', async (req, res) => {
    const status = req.body?.status === undefined ? undefined : req.body.status;
    res.json(await libraryService.setStatus(req.user.id, req.params.workId, status ?? null));
  });

  router.use(jsonErrors());
  return router;
}

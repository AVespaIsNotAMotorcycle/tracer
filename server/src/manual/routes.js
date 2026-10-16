import express from 'express';
import { jsonErrors, requireUser, sessionRequestChecks } from '../auth/routes.js';
import { requireFeature } from '../entitlements/entitlements.js';

/**
 * Routes under /api/manual, for what the signed-in user added by hand (see manualService.js):
 * GET / ({ works, links, linkedWorks }); POST /works, PUT /works/:id, DELETE /works/:id (its
 * links too); POST /links ({ citingId, citedId }), DELETE /links/:id. All need the
 * `manualEdits` feature.
 *
 * @param {ReturnType<typeof import('./manualService.js').createManualService>} manualService
 * @param {ReturnType<typeof import('../auth/authService.js').createAuthService>} authService
 */
export function createManualRouter(manualService, authService) {
  const router = express.Router();
  router.use(sessionRequestChecks());
  router.use(requireUser(authService));
  router.use(requireFeature('manualEdits'));

  router.get('/', async (req, res) => {
    res.json(await manualService.list(req.user.id));
  });

  router.post('/works', async (req, res) => {
    res.status(201).json({ work: await manualService.createWork(req.user.id, req.body ?? {}) });
  });

  router.put('/works/:id', async (req, res) => {
    res.json({ work: await manualService.updateWork(req.user.id, req.params.id, req.body ?? {}) });
  });

  router.delete('/works/:id', async (req, res) => {
    await manualService.deleteWork(req.user.id, req.params.id);
    res.status(204).end();
  });

  router.post('/links', async (req, res) => {
    res.status(201).json({ link: await manualService.addLink(req.user.id, req.body ?? {}) });
  });

  router.delete('/links/:id', async (req, res) => {
    await manualService.removeLink(req.user.id, req.params.id);
    res.status(204).end();
  });

  router.use(jsonErrors());
  return router;
}

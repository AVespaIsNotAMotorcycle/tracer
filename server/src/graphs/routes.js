import express from 'express';
import { jsonErrors, requireUser, sessionRequestChecks } from '../auth/routes.js';

/**
 * Routes under /api/graphs, all for the signed-in user's own saved graphs:
 * GET / lists them; POST / saves one ({ name?, state }); GET /:id opens one; PUT /:id
 * replaces its contents ({ name?, state }); PATCH /:id renames it ({ name }); DELETE /:id
 * deletes it.
 *
 * @param {ReturnType<typeof import('./graphService.js').createGraphService>} graphService
 * @param {ReturnType<typeof import('../auth/authService.js').createAuthService>} authService
 */
export function createGraphsRouter(graphService, authService) {
  const router = express.Router();
  router.use(sessionRequestChecks());
  router.use(requireUser(authService));

  router.get('/', async (req, res) => {
    res.json({ graphs: await graphService.list(req.user.id) });
  });

  router.post('/', async (req, res) => {
    res.status(201).json({ graph: await graphService.create(req.user.id, req.body ?? {}) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ graph: await graphService.get(req.user.id, req.params.id) });
  });

  router.put('/:id', async (req, res) => {
    res.json({ graph: await graphService.update(req.user.id, req.params.id, req.body ?? {}) });
  });

  router.patch('/:id', async (req, res) => {
    res.json({ graph: await graphService.rename(req.user.id, req.params.id, req.body?.name) });
  });

  router.delete('/:id', async (req, res) => {
    await graphService.remove(req.user.id, req.params.id);
    res.status(204).end();
  });

  router.use(jsonErrors());
  return router;
}

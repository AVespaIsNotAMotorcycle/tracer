import express from 'express';
import { jsonErrors, requireUser, sessionRequestChecks } from '../auth/routes.js';
import { entitlementsFor, requireFeature } from '../entitlements/entitlements.js';

/**
 * Routes under /api/graphs, all for the signed-in user's own saved graphs:
 * GET / lists them; POST / saves one ({ name?, state }); GET /:id opens one; PUT /:id
 * replaces its contents ({ name?, state }; its notes too if the state has `annotations`); PATCH /:id renames it ({ name }); DELETE /:id
 * deletes it. POST and PUT also take `snapshot`, the graph as built, which GET /:id returns
 * while it's fresh; PUT /:id/snapshot ({ key, snapshot }) stores one for a graph just rebuilt.
 *
 * Saving needs the `saveGraphs` feature, within the plan's limits. Listing, opening, renaming
 * and deleting don't, so an account that loses it keeps its graphs.
 *
 * @param {ReturnType<typeof import('./graphService.js').createGraphService>} graphService
 * @param {ReturnType<typeof import('../auth/authService.js').createAuthService>} authService
 */
export function createGraphsRouter(graphService, authService) {
  const router = express.Router();
  router.use(sessionRequestChecks());
  router.use(requireUser(authService));
  // Snapshots of built graphs are large, so this router parses its own bodies (app.js mounts it
  // before the 16 kB parser), and only once it knows who's asking.
  router.use(express.json({ limit: '25mb' }));

  router.get('/', async (req, res) => {
    res.json({ graphs: await graphService.list(req.user.id) });
  });

  const limits = (req) => ({ limits: entitlementsFor(req.user).limits });

  router.post('/', requireFeature('saveGraphs'), async (req, res) => {
    const graph = await graphService.create(req.user.id, req.body ?? {}, limits(req));
    res.status(201).json({ graph });
  });

  router.get('/:id', async (req, res) => {
    res.json({ graph: await graphService.get(req.user.id, req.params.id) });
  });

  router.put('/:id', requireFeature('saveGraphs'), async (req, res) => {
    const graph = await graphService.update(
      req.user.id,
      req.params.id,
      req.body ?? {},
      limits(req),
    );
    res.json({ graph });
  });

  router.put('/:id/snapshot', async (req, res) => {
    await graphService.saveSnapshot(req.user.id, req.params.id, req.body ?? {});
    res.status(204).end();
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

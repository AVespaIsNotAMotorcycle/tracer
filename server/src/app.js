import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import { createAuthRouter } from './auth/routes.js';
import { createGraphService } from './graphs/graphService.js';
import { createGraphsRouter } from './graphs/routes.js';
import { createWorksRouter } from './works/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');

/**
 * Builds the Express app with no side effects (no listening, no DB connection), so tests can
 * pass in their own dependencies.
 *
 * @param {object} [deps]
 * @param {ReturnType<typeof import('./works/workService.js').createWorkService>} [deps.workService]
 * @param {ReturnType<typeof import('./auth/authService.js').createAuthService>} [deps.authService]
 * @param {object} [deps.authOptions]  Passed to createAuthRouter (e.g. secureCookies).
 * @param {ReturnType<typeof import('./graphs/graphService.js').createGraphService>} [deps.graphService]
 */
export function createApp({ workService, authService, authOptions, graphService } = {}) {
  const app = express();
  // Heroku's router sits in front: trust its X-Forwarded-* headers for req.ip and HTTPS.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '16kb' }));

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    });
  });

  if (workService) app.use('/api/works', createWorksRouter(workService));
  if (authService) {
    app.use('/api/auth', createAuthRouter(authService, authOptions));
    // Saved graphs belong to accounts, so they come with them.
    app.use('/api/graphs', createGraphsRouter(graphService ?? createGraphService(), authService));
  }

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(clientDist));
    // Let the React app handle any non-API route.
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import mongoose from 'mongoose';
import { createWorksRouter } from './works/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../../client/dist');

/**
 * Builds the Express app with no side effects (no listening, no DB connection), so tests can
 * pass in their own dependencies.
 *
 * @param {object} [deps]
 * @param {ReturnType<typeof import('./works/workService.js').createWorkService>} [deps.workService]
 */
export function createApp({ workService } = {}) {
  const app = express();
  app.use(express.json());

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    });
  });

  if (workService) app.use('/api/works', createWorksRouter(workService));

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(clientDist));
    // Let the React app handle any non-API route.
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}

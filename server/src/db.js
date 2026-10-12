import mongoose from 'mongoose';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connects to MongoDB, retrying until it succeeds. Meant to run in the background so the
 * server can listen immediately; routes that need the database return 503 until then.
 *
 * Mongoose reconnects on its own after a connection has succeeded once, but it never retries
 * a failed *initial* connection, hence this loop.
 *
 * @param {string} uri
 * @param {object} [options]
 * @param {number} [options.retryMs]  Delay between attempts.
 * @param {number} [options.serverSelectionTimeoutMS]  How long each attempt waits.
 * @param {(uri: string, opts: object) => Promise<unknown>} [options.connect]  Injected for tests.
 * @param {(ms: number) => Promise<void>} [options.sleep]  Injected for tests.
 * @param {Pick<Console, 'log' | 'error'>} [options.logger]
 */
export async function connectWithRetry(
  uri,
  {
    retryMs = 5000,
    serverSelectionTimeoutMS = 5000,
    connect = (...args) => mongoose.connect(...args),
    sleep = defaultSleep,
    logger = console,
  } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      await connect(uri, { serverSelectionTimeoutMS });
      logger.log(
        attempt === 1 ? 'Connected to MongoDB' : `Connected to MongoDB after ${attempt} attempts`,
      );
      return;
    } catch (err) {
      // Log the first failure only, so a missing database doesn't flood the console.
      if (attempt === 1) {
        logger.error(
          `MongoDB connection failed: ${err.message}. Retrying every ${retryMs / 1000}s; ` +
            '/api/works returns 503 until connected.',
        );
      }
      await sleep(retryMs);
    }
  }
}

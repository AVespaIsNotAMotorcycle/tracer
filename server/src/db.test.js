import { describe, expect, it, vi } from 'vitest';
import { connectWithRetry } from './db.js';

const logger = () => ({ log: vi.fn(), error: vi.fn() });

describe('connectWithRetry', () => {
  it('connects on the first try', async () => {
    const connect = vi.fn().mockResolvedValue();
    const log = logger();

    await connectWithRetry('mongodb://db', { connect, logger: log, sleep: vi.fn() });

    expect(connect).toHaveBeenCalledWith('mongodb://db', { serverSelectionTimeoutMS: 5000 });
    expect(log.log).toHaveBeenCalledWith('Connected to MongoDB');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('retries until the database is reachable, logging the failure once', async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue();
    const sleep = vi.fn().mockResolvedValue();
    const log = logger();

    await connectWithRetry('mongodb://db', { connect, sleep, logger: log, retryMs: 2000 });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[2000], [2000]]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(/ECONNREFUSED.*Retrying every 2s/);
    expect(log.log).toHaveBeenCalledWith('Connected to MongoDB after 3 attempts');
  });
});

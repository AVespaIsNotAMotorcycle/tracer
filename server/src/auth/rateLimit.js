/**
 * Counts attempts per key (an IP address, an email) in a fixed window, in memory: enough for
 * Tracer's single dyno. With several server processes this would need shared storage.
 *
 * @param {object} options
 * @param {number} options.max  Attempts allowed per key per window.
 * @param {number} options.windowMs
 * @param {() => number} [options.now]  Injected for tests.
 */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const windows = new Map();
  return {
    /** Records an attempt for `key`; returns false once it's over the limit. */
    attempt(key) {
      const time = now();
      // Drop finished windows now and then, so the map doesn't grow without bound.
      if (windows.size > 10_000) {
        for (const [k, w] of windows) if (time >= w.resetAt) windows.delete(k);
      }
      let window = windows.get(key);
      if (!window || time >= window.resetAt) {
        window = { count: 0, resetAt: time + windowMs };
        windows.set(key, window);
      }
      window.count++;
      return window.count <= max;
    },
  };
}

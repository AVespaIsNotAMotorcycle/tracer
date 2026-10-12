// Progress tracking for graph loading (build, re-anchor, expand).
//
// Work is counted in API requests. Graph code `plan`s requests it knows it will make, times
// each real request with `begin()` (which returns its finish function), marks planned requests
// it skips with `complete()`, and `project`s how many more it expects beyond what's planned.
//
// Time remaining = remaining requests x average request latency / parallelism. Latency is
// measured per request (not wall clock), so it adapts to cached versus uncached responses and
// isn't skewed by skipped requests or by requests running concurrently.
//
// Separately from those counts, the tracker can list which requests are running and queued:
// callers `queue` requests they know are coming (each `{ key, label }`), pass the same item to
// `begin` when one starts, and `dequeue` ones they skip.

/**
 * @typedef {object} ProgressSnapshot
 * @property {string} label
 * @property {number} done            Requests completed (or skipped).
 * @property {number} total           Planned + projected requests; grows as levels are revealed.
 * @property {boolean} estimated      True while `total` includes projected requests.
 * @property {number} works           Works on the graph so far.
 * @property {number | null} expectedWorks  Estimated final count, when one can be made.
 * @property {number | null} etaMs    Estimated time remaining; null until a request completes.
 * @property {string[]} running       Labels of requests in progress, oldest first.
 * @property {string[]} queued        Labels of requests waiting to start, in order.
 */

/** @typedef {{ key: string, label: string }} RequestInfo */

/**
 * @param {object} options
 * @param {string} options.label
 * @param {number} [options.parallelism]  Requests the caller runs at once.
 * @param {(snapshot: ProgressSnapshot) => void} [options.onChange]
 * @param {() => number} [options.now]  Injected for tests.
 */
export function createProgressTracker({
  label,
  parallelism = 1,
  onChange = () => {},
  now = () => Date.now(),
}) {
  let latencyTotal = 0;
  let timed = 0;
  let planned = 0;
  let projected = 0;
  let done = 0;
  let works = 0;
  let expectedWorks = null;
  /** @type {Map<string, string>} */
  const running = new Map();
  /** @type {Map<string, string>} */
  const queued = new Map();
  let anonymous = 0;

  const snapshot = () => {
    const total = Math.max(done, planned + projected);
    return {
      label,
      done,
      total,
      estimated: projected > 0,
      works,
      expectedWorks,
      etaMs: timed > 0 ? ((total - done) * (latencyTotal / timed)) / parallelism : null,
      running: [...running.values()],
      queued: [...queued.values()],
    };
  };
  const emit = () => onChange(snapshot());

  return {
    /** Adds requests that will definitely be made (or explicitly skipped). */
    plan(requests) {
      planned += requests;
      emit();
    },
    /**
     * Lists requests that will be made, by key, so they show as queued until they `begin`.
     * Doesn't change the counts; `plan` does that.
     *
     * @param {RequestInfo[]} requests
     */
    queue(requests) {
      for (const { key, label } of requests) if (!running.has(key)) queued.set(key, label);
      emit();
    },
    /** Removes a queued request that won't be made after all. */
    dequeue(key) {
      if (queued.delete(key)) emit();
    },
    /**
     * Starts timing a real request; call the returned function when it finishes. With
     * `request`, it's listed as running until then (and no longer as queued).
     *
     * @param {RequestInfo} [request]
     */
    begin(request) {
      const startedAt = now();
      const key = request?.key ?? `#${anonymous++}`;
      queued.delete(key);
      if (request) running.set(key, request.label);
      emit();
      return () => {
        latencyTotal += now() - startedAt;
        timed++;
        done++;
        running.delete(key);
        emit();
      };
    },
    /** Marks planned requests as skipped (not made), so `done` still reaches `total`. */
    complete(requests = 1) {
      done += requests;
      emit();
    },
    /** Sets the expected number of requests beyond those planned. */
    project(requests) {
      projected = Math.max(0, Math.round(requests));
      emit();
    },
    setWorks(count, expected = null) {
      works = count;
      expectedWorks = expected == null ? null : Math.max(count, Math.round(expected));
      emit();
    },
    snapshot,
  };
}

/** A tracker that records nothing, for callers that don't need progress. */
export const noProgress = {
  plan() {},
  queue() {},
  dequeue() {},
  begin: () => () => {},
  complete() {},
  project() {},
  setWorks() {},
  snapshot: () => null,
};

/** Human-readable time remaining, e.g. "about 8 s left". */
export function formatEta(etaMs) {
  if (etaMs == null) return 'estimating time…';
  if (etaMs < 1500) return 'almost done';
  const seconds = Math.round(etaMs / 1000);
  if (seconds < 60) return `about ${seconds} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

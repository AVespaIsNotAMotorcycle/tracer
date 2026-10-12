// Progress tracking for graph loading (build, re-anchor, expand).
//
// Work is counted in API requests. Graph code `plan`s requests it knows it will make, times
// each real request with `begin()` (which returns its finish function), marks planned requests
// it skips with `complete()`, and `project`s how many more it expects beyond what's planned.
//
// Time remaining = remaining requests x average request latency / parallelism. Latency is
// measured per request (not wall clock), so it adapts to cached versus uncached responses and
// isn't skewed by skipped requests or by requests running concurrently.

/**
 * @typedef {object} ProgressSnapshot
 * @property {string} label
 * @property {number} done            Requests completed (or skipped).
 * @property {number} total           Planned + projected requests; grows as levels are revealed.
 * @property {boolean} estimated      True while `total` includes projected requests.
 * @property {number} works           Works on the graph so far.
 * @property {number | null} expectedWorks  Estimated final count, when one can be made.
 * @property {number | null} etaMs    Estimated time remaining; null until a request completes.
 */

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
    };
  };
  const emit = () => onChange(snapshot());

  return {
    /** Adds requests that will definitely be made (or explicitly skipped). */
    plan(requests) {
      planned += requests;
      emit();
    },
    /** Starts timing a real request; call the returned function when it finishes. */
    begin() {
      const startedAt = now();
      return () => {
        latencyTotal += now() - startedAt;
        timed++;
        done++;
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

import { useCallback, useEffect, useRef, useState } from 'react';
import * as defaultApi from '../api.js';
import {
  addExpandedWorks,
  applyCoCitations as applyCoCitationsTo,
  applyPath,
  buildGraph,
  collapseWorks,
  emptyGraph,
  expandWorks,
  findCoCitations as findCoCitationsIn,
  graphFromSnapshot,
  reanchorGraph,
  restoreGraph,
  sameAnchors,
} from './graphModel.js';
import { createProgressTracker } from './progress.js';

/** @typedef {import('./graphModel.js').BuildOptions} BuildOptions */

/**
 * Graph state plus build, re-anchor, and expand actions. Starting a build or re-anchor cancels
 * any one in progress; results from a cancelled run are discarded.
 */
export function useCitationGraph(api = defaultApi) {
  const [graph, setGraph] = useState(emptyGraph);
  const [status, setStatus] = useState(
    /** @type {'idle' | 'loading' | 'reanchoring' | 'done' | 'error'} */ ('idle'),
  );
  // Progress for each running task, keyed 'run' (build or re-anchor) or 'expand:<id>'.
  const [tasks, setTasks] = useState(() => new Map());
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [expanding, setExpanding] = useState(() => new Set());
  const controller = useRef(null);
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  /** Creates a progress tracker whose updates land in `tasks[key]` until `signal` aborts. */
  const track = useCallback((key, label, signal, parallelism = 1) => {
    return createProgressTracker({
      label,
      parallelism,
      onChange: (snapshot) => {
        if (!signal?.aborted) setTasks((prev) => new Map(prev).set(key, snapshot));
      },
    });
  }, []);
  const untrack = useCallback((key) => {
    setTasks((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  /** Cancels any run in progress and returns an API bound to a fresh abort signal. */
  const startRun = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const { signal } = current;
    const scoped = {
      getWork: (id) => api.getWork(id, { signal }),
      getCiting: (id, opts) => api.getCiting(id, { ...opts, signal }),
      getCited: (id, opts) => api.getCited(id, { ...opts, signal }),
    };
    return { signal, scoped };
  }, [api]);

  // Builds a new graph around `anchorIds` (any IDs the API accepts).
  const build = useCallback(
    async (anchorIds, /** @type {BuildOptions} */ options) => {
      const { signal, scoped } = startRun();
      setGraph(emptyGraph());
      setStatus('loading');
      setError(null);
      setTruncated(false);
      setExpanding(new Set());
      const progress = track('run', 'Building graph', signal, options.concurrency ?? 4);
      try {
        const result = await buildGraph(
          anchorIds,
          options,
          scoped,
          (g) => {
            if (!signal.aborted) setGraph(g);
          },
          progress,
        );
        if (signal.aborted) return;
        setGraph(result.graph);
        setTruncated(result.truncated);
        setStatus('done');
      } catch (err) {
        if (signal.aborted) return;
        setError(err.message);
        setStatus('error');
      } finally {
        if (!signal.aborted) untrack('run');
      }
    },
    [startRun, track, untrack],
  );

  /**
   * Opens a saved graph: from `saved.snapshot` (the graph as last built) when there is one,
   * without fetching anything; otherwise rebuilt (see restoreGraph), like build and then its
   * expansions again. Resolves to the rebuilt { graph, truncated }, or null when it came from
   * the snapshot, failed or was cancelled.
   */
  const restore = useCallback(
    async (saved, label) => {
      const { signal, scoped } = startRun();
      setError(null);
      setExpanding(new Set());
      if (saved.snapshot) {
        const loaded = graphFromSnapshot(saved.snapshot);
        setGraph(loaded.graph);
        setTruncated(loaded.truncated);
        setStatus('done');
        untrack('run');
        return null;
      }
      setGraph(emptyGraph());
      setStatus('loading');
      setTruncated(false);
      const progress = track('run', label, signal, saved.options.concurrency ?? 4);
      try {
        const result = await restoreGraph(
          saved,
          scoped,
          (g) => {
            if (!signal.aborted) setGraph(g);
          },
          progress,
        );
        if (signal.aborted) return null;
        setGraph(result.graph);
        setTruncated(result.truncated);
        setStatus('done');
        return result;
      } catch (err) {
        if (signal.aborted) return null;
        setError(err.message);
        setStatus('error');
        return null;
      } finally {
        if (!signal.aborted) untrack('run');
      }
    },
    [startRun, track, untrack],
  );

  // Keeps showing the current graph until the new one is complete, so works that stay keep
  // their positions instead of the view collapsing to the new anchor and regrowing.
  const rebuild = useCallback(
    async (from, anchorIds, /** @type {BuildOptions} */ options, label, extra) => {
      const { signal, scoped } = startRun();
      setStatus('reanchoring');
      setError(null);
      const progress = track('run', label, signal, 3);
      try {
        const result = await reanchorGraph(
          from,
          anchorIds,
          options,
          scoped,
          undefined,
          progress,
          extra,
        );
        if (signal.aborted) return;
        setGraph(result.graph);
        setTruncated(result.truncated);
        setStatus('done');
      } catch (err) {
        if (signal.aborted) return;
        // The previous graph is still intact, so stay usable and just report the error.
        setError(err.message);
        setStatus('done');
      } finally {
        if (!signal.aborted) untrack('run');
      }
    },
    [startRun, track, untrack],
  );

  /**
   * Rebuilds around `anchorIds`, works on the graph: a new anchor, the anchors with one added
   * or removed, or the same ones. `unstick` (an anchor being removed) loses its neighbors.
   */
  const reanchor = useCallback(
    (
      anchorIds,
      /** @type {BuildOptions} */ options,
      { unstick = [], label = 'Re-anchoring' } = {},
    ) => rebuild(graphRef.current, anchorIds, options, label, { unstick }),
    [rebuild],
  );

  /**
   * Undoes the expansion of `ids` (a work, or a book and its chapters): rebuilds on the same
   * anchors without them sticky, so their neighbors stay only if something else reaches them.
   */
  const collapse = useCallback(
    (ids, /** @type {BuildOptions} */ options) => {
      const current = graphRef.current;
      const title = current.works.get(ids[0])?.title ?? 'work';
      const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      return rebuild(
        collapseWorks(current, ids),
        current.anchorIds,
        options,
        `Collapsing “${short}”`,
      );
    },
    [rebuild],
  );

  /**
   * Adds works (from a search, say) to the graph on screen and expands each, as if the user
   * had. Like a re-anchor, it's a run: the graph stays on screen until the result is in.
   */
  const addWorks = useCallback(
    async (ids, /** @type {BuildOptions} */ options) => {
      const { signal, scoped } = startRun();
      setStatus('reanchoring');
      setError(null);
      const label = `Adding ${ids.length} work${ids.length === 1 ? '' : 's'}`;
      const progress = track('run', label, signal, 2);
      progress.plan(ids.length * 2);
      try {
        const graph = await addExpandedWorks(
          graphRef.current,
          ids,
          options,
          scoped,
          undefined,
          progress,
        );
        if (signal.aborted) return;
        setGraph(graph);
        setStatus('done');
      } catch (err) {
        if (signal.aborted) return;
        setError(err.message);
        setStatus('done');
      } finally {
        if (!signal.aborted) untrack('run');
      }
    },
    [startRun, track, untrack],
  );

  /** Cancels any run in progress and clears the graph. */
  const reset = useCallback(() => {
    controller.current?.abort();
    setGraph(emptyGraph());
    setStatus('idle');
    setError(null);
    setTruncated(false);
    setExpanding(new Set());
    untrack('run');
  }, [untrack]);

  // Expands `id`, along with any `parts` (a book's chapters, which aren't nodes of their own).
  const expand = useCallback(
    async (id, { limit, parts = [] }) => {
      setExpanding((prev) => new Set(prev).add(id));
      const title = graphRef.current.works.get(id)?.title ?? 'work';
      const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      const ids = [id, ...parts];
      // Up to two works at once, each fetching both directions.
      const progress = track(
        `expand:${id}`,
        `Expanding “${short}”`,
        undefined,
        Math.min(4, 2 * ids.length),
      );
      progress.plan(2 * ids.length); // Citing and cited, per work.
      try {
        const apply = await expandWorks(graphRef.current, ids, { limit }, api, progress);
        setGraph((latest) => (latest.works.has(id) ? apply(latest) : latest));
      } catch (err) {
        setError(err.message);
      } finally {
        untrack(`expand:${id}`);
        setExpanding((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [api, track, untrack],
  );

  /**
   * Looks for works co-cited with an anchor (see findCoCitations), then shows those at least
   * `minCiters` citing works cite (see applyCoCitations). `targets` are the anchor and its
   * chapters. Resolves to the search's results (every count of 2 or more), for changing the
   * minimum later, or null if it failed or the anchors changed meanwhile.
   */
  const findCoCitations = useCallback(
    async (targets, { limit, maxNodes, minCiters, keep }) => {
      const anchorIds = graphRef.current.anchorIds;
      const progress = track('cocite', 'Finding co-citations', undefined, 3);
      try {
        const result = await findCoCitationsIn(graphRef.current, targets, { limit }, api, progress);
        if (!sameAnchors(graphRef.current.anchorIds, anchorIds)) return null;
        setGraph((latest) =>
          sameAnchors(latest.anchorIds, anchorIds)
            ? applyCoCitationsTo(latest, result, { minCiters, maxNodes, keep })
            : latest,
        );
        return result;
      } catch (err) {
        setError(err.message);
        return null;
      } finally {
        untrack('cocite');
      }
    },
    [api, track, untrack],
  );

  /**
   * Asks the server for the shortest path of citations from `fromId` to the nearest of
   * `toIds` (anchors; all of them by default; see findPath in api.js) and adds its works to the
   * graph. Resolves to the search's result, or null if it failed or the anchors changed
   * meanwhile.
   */
  const findPath = useCallback(
    async (fromId, toIds = graphRef.current.anchorIds) => {
      const anchorIds = graphRef.current.anchorIds;
      const title = graphRef.current.works.get(fromId)?.title ?? 'work';
      const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      // One request, searched in batches on the server.
      const progress = track('path', `Finding a path from “${short}”`, undefined, 1);
      progress.plan(1);
      const finish = progress.begin({ key: `path:${fromId}`, label: 'Searching citations' });
      try {
        const result = await api.findPath(fromId, toIds);
        if (!sameAnchors(graphRef.current.anchorIds, anchorIds)) return null;
        if (result.path) {
          setGraph((latest) =>
            sameAnchors(latest.anchorIds, anchorIds) ? applyPath(latest, result.path) : latest,
          );
        }
        return result;
      } catch (err) {
        setError(err.message);
        return null;
      } finally {
        finish();
        untrack('path');
      }
    },
    [api, track, untrack],
  );

  /** Shows the co-citations of an earlier search at a new minimum (see applyCoCitations). */
  const applyCoCitations = useCallback((result, options) => {
    setGraph((latest) => applyCoCitationsTo(latest, result, options));
  }, []);

  return {
    graph,
    status,
    tasks: [...tasks].map(([key, snapshot]) => ({ key, ...snapshot })),
    error,
    truncated,
    expanding,
    build,
    restore,
    reanchor,
    expand,
    collapse,
    addWorks,
    findCoCitations,
    applyCoCitations,
    findPath,
    reset,
  };
}

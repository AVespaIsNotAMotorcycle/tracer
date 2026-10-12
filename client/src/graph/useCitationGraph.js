import { useCallback, useEffect, useRef, useState } from 'react';
import * as defaultApi from '../api.js';
import { buildGraph, emptyGraph, expandWork, reanchorGraph } from './graphModel.js';
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

  const build = useCallback(
    async (anchorId, /** @type {BuildOptions} */ options) => {
      const { signal, scoped } = startRun();
      setGraph(emptyGraph());
      setStatus('loading');
      setError(null);
      setTruncated(false);
      setExpanding(new Set());
      const progress = track('run', 'Building graph', signal, options.concurrency ?? 4);
      try {
        const result = await buildGraph(
          anchorId,
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

  // Keeps showing the current graph until the new one is complete, so works that stay keep
  // their positions instead of the view collapsing to the new anchor and regrowing.
  const reanchor = useCallback(
    async (anchorId, /** @type {BuildOptions} */ options) => {
      const { signal, scoped } = startRun();
      setStatus('reanchoring');
      setError(null);
      const progress = track('run', 'Re-anchoring', signal, 3);
      try {
        const result = await reanchorGraph(
          graphRef.current,
          anchorId,
          options,
          scoped,
          undefined,
          progress,
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

  const expand = useCallback(
    async (id, { limit }) => {
      setExpanding((prev) => new Set(prev).add(id));
      const title = graphRef.current.works.get(id)?.title ?? 'work';
      const short = title.length > 40 ? `${title.slice(0, 39)}…` : title;
      const progress = track(`expand:${id}`, `Expanding “${short}”`, undefined, 2);
      progress.plan(2); // Citing and cited.
      try {
        const apply = await expandWork(graphRef.current, id, { limit }, api, progress);
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

  return {
    graph,
    status,
    tasks: [...tasks].map(([key, snapshot]) => ({ key, ...snapshot })),
    error,
    truncated,
    expanding,
    build,
    reanchor,
    expand,
  };
}

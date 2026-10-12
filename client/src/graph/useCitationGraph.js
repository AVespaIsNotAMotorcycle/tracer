import { useCallback, useEffect, useRef, useState } from 'react';
import * as defaultApi from '../api.js';
import { buildGraph, emptyGraph, expandWork, reanchorGraph } from './graphModel.js';

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
  // Works gathered so far by a re-anchor, which doesn't show its graph until it's done.
  const [progressCount, setProgressCount] = useState(0);
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [expanding, setExpanding] = useState(() => new Set());
  const controller = useRef(null);
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

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
      try {
        const result = await buildGraph(anchorId, options, scoped, (g) => {
          if (!signal.aborted) setGraph(g);
        });
        if (signal.aborted) return;
        setGraph(result.graph);
        setTruncated(result.truncated);
        setStatus('done');
      } catch (err) {
        if (signal.aborted) return;
        setError(err.message);
        setStatus('error');
      }
    },
    [startRun],
  );

  // Keeps showing the current graph until the new one is complete, so works that stay keep
  // their positions instead of the view collapsing to the new anchor and regrowing.
  const reanchor = useCallback(
    async (anchorId, /** @type {BuildOptions} */ options) => {
      const { signal, scoped } = startRun();
      setStatus('reanchoring');
      setProgressCount(0);
      setError(null);
      try {
        const result = await reanchorGraph(graphRef.current, anchorId, options, scoped, (g) => {
          if (!signal.aborted) setProgressCount(g.works.size);
        });
        if (signal.aborted) return;
        setGraph(result.graph);
        setTruncated(result.truncated);
        setStatus('done');
      } catch (err) {
        if (signal.aborted) return;
        // The previous graph is still intact, so stay usable and just report the error.
        setError(err.message);
        setStatus('done');
      }
    },
    [startRun],
  );

  const expand = useCallback(
    async (id, { limit }) => {
      setExpanding((prev) => new Set(prev).add(id));
      try {
        const apply = await expandWork(graphRef.current, id, { limit }, api);
        setGraph((latest) => (latest.works.has(id) ? apply(latest) : latest));
      } catch (err) {
        setError(err.message);
      } finally {
        setExpanding((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [api],
  );

  return { graph, status, progressCount, error, truncated, expanding, build, reanchor, expand };
}

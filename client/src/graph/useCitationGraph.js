import { useCallback, useEffect, useRef, useState } from 'react';
import * as defaultApi from '../api.js';
import { buildGraph, emptyGraph, expandWork } from './graphModel.js';

/** @typedef {import('./graphModel.js').BuildOptions} BuildOptions */

/**
 * Graph state plus build and expand actions. Starting a new build cancels any build in
 * progress; results from a cancelled build are discarded.
 */
export function useCitationGraph(api = defaultApi) {
  const [graph, setGraph] = useState(emptyGraph);
  const [status, setStatus] = useState(
    /** @type {'idle' | 'loading' | 'done' | 'error'} */ ('idle'),
  );
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [expanding, setExpanding] = useState(() => new Set());
  const controller = useRef(null);
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  const build = useCallback(
    async (anchorId, /** @type {BuildOptions} */ options) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      const { signal } = current;
      const scoped = {
        getWork: (id) => api.getWork(id, { signal }),
        getCiting: (id, opts) => api.getCiting(id, { ...opts, signal }),
        getCited: (id, opts) => api.getCited(id, { ...opts, signal }),
      };

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
    [api],
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

  return { graph, status, error, truncated, expanding, build, expand };
}

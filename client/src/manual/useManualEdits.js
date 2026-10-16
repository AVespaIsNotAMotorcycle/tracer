import { useCallback, useEffect, useState } from 'react';
import * as defaultApi from '../api.js';
import { NO_MANUAL } from '../graph/manualOverlay.js';

const byId = (works) => new Map(works.map((work) => [work.id, work]));

/**
 * What the signed-in user added by hand (see manualOverlay.js): loaded once they're known to
 * be signed in with the `manualEdits` feature, with ways to add and remove works and citations.
 * Each change is sent first and applied when the server confirms it; `error` says why one
 * failed. Signed out, there's nothing.
 *
 * @param {{ user: object | null | undefined, can: (feature: string) => boolean }} auth
 */
export function useManualEdits(auth, api = defaultApi) {
  const enabled = Boolean(auth.user) && auth.can('manualEdits');
  const userId = auth.user?.id ?? null;
  const [loaded, setLoaded] = useState({ userId: null, manual: NO_MANUAL });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    api
      .getManual()
      .then(({ works, links, linkedWorks }) => {
        if (current) {
          setLoaded({
            userId,
            manual: { works: byId(works), links, linkedWorks: byId(linkedWorks) },
          });
        }
      })
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [api, enabled, userId]);

  const manual = enabled && loaded.userId === userId ? loaded.manual : NO_MANUAL;
  const update = (change) =>
    setLoaded((prev) => ({ ...prev, userId, manual: change(prev.manual) }));

  /** Runs a change, reporting a failure in `error`; resolves to its result, or null. */
  const attempt = useCallback(async (task) => {
    setError(null);
    try {
      return await task();
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, []);

  /**
   * Records that `citingId` cites `citedId`. `works` are the works it joins, as the graph has
   * them, so a provider work not on the graph later can still be shown with the link.
   */
  const addLink = useCallback(
    (citingId, citedId, works = []) =>
      attempt(async () => {
        const link = await api.addManualLink(citingId, citedId);
        update((prev) => {
          const linkedWorks = new Map(prev.linkedWorks);
          for (const work of works) {
            if (work && !work.manual && !linkedWorks.has(work.id)) linkedWorks.set(work.id, work);
          }
          const links = prev.links.some((l) => l.id === link.id)
            ? prev.links
            : [...prev.links, link];
          return { ...prev, links, linkedWorks };
        });
        return link;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update only calls setLoaded.
    [api, attempt, userId],
  );

  const removeLink = useCallback(
    (id) =>
      attempt(async () => {
        await api.removeManualLink(id);
        update((prev) => ({ ...prev, links: prev.links.filter((link) => link.id !== id) }));
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update only calls setLoaded.
    [api, attempt, userId],
  );

  /** Adds a work no database has, and resolves to it (or null if that failed). */
  const createWork = useCallback(
    (fields) =>
      attempt(async () => {
        const work = await api.createManualWork(fields);
        update((prev) => ({ ...prev, works: new Map(prev.works).set(work.id, work) }));
        return work;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update only calls setLoaded.
    [api, attempt, userId],
  );

  /** Deletes a work the user added, with its citations. */
  const deleteWork = useCallback(
    (id) =>
      attempt(async () => {
        await api.deleteManualWork(id);
        update((prev) => {
          const works = new Map(prev.works);
          works.delete(id);
          const links = prev.links.filter((link) => link.citingId !== id && link.citedId !== id);
          return { ...prev, works, links };
        });
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- update only calls setLoaded.
    [api, attempt, userId],
  );

  /** Shows why a change couldn't be made before it reached the server. */
  const reportError = useCallback((message) => setError(message), []);

  return { enabled, manual, addLink, removeLink, createWork, deleteWork, error, reportError };
}

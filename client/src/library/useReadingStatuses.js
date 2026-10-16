import { useCallback, useEffect, useState } from 'react';
import * as defaultApi from '../api.js';

/**
 * The signed-in user's reading statuses (workId → status), loaded once they're known to be
 * signed in with the `library` feature, and a way to change one. Changes show at once and are
 * undone if the server refuses them (`error` says why). Signed out, there are none.
 *
 * @param {{ user: object | null | undefined, can: (feature: string) => boolean }} auth
 */
export function useReadingStatuses(auth, api = defaultApi) {
  const enabled = Boolean(auth.user) && auth.can('library');
  const userId = auth.user?.id ?? null;
  const [loaded, setLoaded] = useState({ userId: null, statuses: new Map() });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let current = true;
    api
      .getReadingStatuses()
      .then((found) => {
        if (current) setLoaded({ userId, statuses: new Map(Object.entries(found)) });
      })
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [api, enabled, userId]);

  const statuses = enabled && loaded.userId === userId ? loaded.statuses : EMPTY;

  const setStatus = useCallback(
    async (workId, status) => {
      const apply = (value) =>
        setLoaded((prev) => {
          const next = new Map(prev.statuses);
          if (value) next.set(workId, value);
          else next.delete(workId);
          return { ...prev, statuses: next };
        });
      const before = loaded.statuses.get(workId) ?? null;
      apply(status);
      setError(null);
      try {
        const saved = await api.setReadingStatus(workId, status);
        // Stored under the work it was merged into, if it was.
        if (saved.workId !== workId) {
          apply(null);
          setLoaded((prev) => {
            const next = new Map(prev.statuses);
            if (saved.status) next.set(saved.workId, saved.status);
            return { ...prev, statuses: next };
          });
        }
      } catch (err) {
        apply(before);
        setError(err.message);
      }
    },
    [api, loaded.statuses],
  );

  return { enabled, statuses, setStatus, error };
}

const EMPTY = new Map();

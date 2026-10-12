import { useCallback, useEffect, useState } from 'react';
import * as defaultApi from '../api.js';

/**
 * The signed-in account and actions to change it. `user` is undefined while the first check
 * runs, then the account or null.
 */
export function useAuth(api = defaultApi) {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    let current = true;
    api
      .getCurrentUser()
      // Without a database (or offline), just show the app signed out.
      .catch(() => null)
      .then((found) => {
        if (current) setUser(found);
      });
    return () => {
      current = false;
    };
  }, [api]);

  const signUp = useCallback(
    async (email, password) => setUser(await api.signUp(email, password)),
    [api],
  );
  const logIn = useCallback(
    async (email, password) => setUser(await api.logIn(email, password)),
    [api],
  );
  const logOut = useCallback(async () => {
    await api.logOut();
    setUser(null);
  }, [api]);

  return { user, signUp, logIn, logOut };
}

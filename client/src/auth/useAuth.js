import { useCallback, useEffect, useMemo, useState } from 'react';
import * as defaultApi from '../api.js';
import { ANONYMOUS, can } from './entitlements.js';

/**
 * The signed-in account, what its plan includes, and actions to change it. `user` is undefined
 * while the first check runs, then the account or null. Until then (or if the check fails),
 * `entitlements` are the signed-out plan's; `can(feature)` and `limits` read them.
 */
export function useAuth(api = defaultApi) {
  // { user, entitlements } from the server, or undefined before it answers.
  const [account, setAccount] = useState(undefined);

  useEffect(() => {
    let current = true;
    api
      .getAccount()
      // Without a database (or offline), just show the app signed out.
      .catch(() => ({ user: null }))
      .then((found) => {
        if (current) setAccount(found);
      });
    return () => {
      current = false;
    };
  }, [api]);

  const signUp = useCallback(
    async (email, password) => setAccount(await api.signUp(email, password)),
    [api],
  );
  const logIn = useCallback(
    async (email, password) => setAccount(await api.logIn(email, password)),
    [api],
  );
  const logOut = useCallback(async () => {
    await api.logOut();
    setAccount({ user: null });
  }, [api]);

  const entitlements = account?.entitlements ?? ANONYMOUS;
  const canDo = useCallback((feature) => can(entitlements, feature), [entitlements]);

  return useMemo(
    () => ({
      user: account === undefined ? undefined : account.user,
      entitlements,
      can: canDo,
      limits: entitlements.limits,
      signUp,
      logIn,
      logOut,
    }),
    [account, entitlements, canDo, signUp, logIn, logOut],
  );
}

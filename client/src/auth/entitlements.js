// What the user's plan includes, as the server reports it with the account (/api/auth/me):
// { plan, features: { name: boolean }, limits: { name: number } }. The server decides
// (server/src/entitlements/); the client only shows it, disabling what the plan doesn't include.

// The signed-out plan, used until the server answers (or if it can't). A test keeps it in sync
// with the server's.
export const ANONYMOUS = {
  plan: 'anonymous',
  features: {
    saveGraphs: false,
    autoSave: false,
    coCitations: true,
    pathSearch: true,
    advancedSearch: true,
  },
  limits: { depth: 3, perNode: 200, maxNodes: 2000, savedGraphs: 0, anchors: 2 },
};

/** Shown beside a control the plan doesn't include. */
export const NOT_IN_PLAN = 'Not included in your plan';

/** Whether `entitlements` include `feature`. Throws on an unknown feature. */
export function can(entitlements, feature) {
  if (!(feature in ANONYMOUS.features)) throw new Error(`Unknown feature: ${feature}`);
  return Boolean(entitlements.features[feature]);
}

/** The build options with each within the plan's limits (the same object if all are). */
export function clampOptions(options, limits) {
  const clamped = {
    citingDepth: Math.min(options.citingDepth, limits.depth),
    citedDepth: Math.min(options.citedDepth, limits.depth),
    limit: Math.min(options.limit, limits.perNode),
    maxNodes: Math.min(options.maxNodes, limits.maxNodes),
  };
  return Object.keys(clamped).every((key) => clamped[key] === options[key])
    ? options
    : { ...options, ...clamped };
}

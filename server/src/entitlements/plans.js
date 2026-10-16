// What each plan includes: features (on or off) and limits (numbers). The one place a plan's
// contents are defined; routes ask through entitlements.js, never read these directly.
//
// Every tier includes every feature that exists; only the number of anchors differs so far.
// A new paid feature adds its key here (and to the client's ANONYMOUS copy in
// client/src/auth/entitlements.js, if signed-out visitors get it).

/** @typedef {'anonymous' | 'free' | 'scholar'} PlanName  `anonymous` is anyone signed out. */

/** Plans an account can be on. */
export const ACCOUNT_PLANS = ['free', 'scholar'];

const EVERYTHING = {
  features: {
    // Saving graphs to an account, and auto-saving each change.
    saveGraphs: true,
    autoSave: true,
    // "Find Co-Citations" in the anchor's details (runs in the client, so gated there only).
    coCitations: true,
    // "Find shortest path to the anchor" (GET /api/works/:id/path).
    pathSearch: true,
    // The advanced search page (GET /api/works/search).
    advancedSearch: true,
    // Reading statuses and the library page (/api/library). Needs an account.
    library: true,
    // Works and citations added by hand (/api/manual). Needs an account.
    manualEdits: true,
  },
  limits: {
    // Build options: depth in each direction, works per node (also the `limit` of the works
    // routes) and max works. Their ceilings are the ranges urlState.js accepts.
    depth: 3,
    perNode: 200,
    maxNodes: 2000,
    // Saved graphs per account.
    savedGraphs: 500,
    // Anchors a graph can be built around at once.
    anchors: 2,
  },
};

/** @type {Record<PlanName, { features: Record<string, boolean>, limits: Record<string, number> }>} */
export const PLANS = {
  anonymous: {
    features: {
      ...EVERYTHING.features,
      saveGraphs: false,
      autoSave: false,
      library: false,
      manualEdits: false,
    },
    limits: { ...EVERYTHING.limits, savedGraphs: 0 },
  },
  free: EVERYTHING,
  // Six anchors: as many as there are distinct anchor colors (--anchor-1 … 6 in App.css).
  scholar: { features: EVERYTHING.features, limits: { ...EVERYTHING.limits, anchors: 6 } },
};

export const FEATURES = Object.keys(EVERYTHING.features);
export const LIMITS = Object.keys(EVERYTHING.limits);

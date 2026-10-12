# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Tracer builds interactive citation graphs for academic sources, focused on the humanities, especially history. See `README.md` for the user-facing description.

Core model:

- **Node:** a source (article). It is drawn as a circle whose radius scales with its **in-graph** citation count: how many works on the current graph cite it, not its global total. That count changes as the graph grows, so derive it from the edges instead of storing it. This choice may be revisited, so keep the sizing metric easy to swap.
- **Edge:** a directed citation (A cites B). Every known citation between any two nodes on the graph is drawn, not only those involving the anchor.
- **Anchor:** the work the user searched for, which the graph is built around. Use this term in code and UI (not "root").
- **Graph build:** from the anchor, fetch citing works (incoming edges) and cited works (outgoing edges), breadth-first. The two directions have **separate depths**, e.g. citing depth 1 and cited depth 3.
- **Expansion:** clicking a node fetches its citing and cited works and merges them into the existing graph.
- **Layout by year:** time runs along an axis tilted 30° below horizontal by default, with older works up and to the left and newer works down and to the right. Users can rotate the axis from 0° (horizontal) to 90° (vertical). For undated works, a work the anchor cites is treated as older than the anchor, and a work citing the anchor as newer. Beyond that, a work is placed older than its dated citers and newer than the dated works it cites (`layoutYears`).
- **Re-anchoring:** any selected work can become the anchor. The graph is rebuilt from it at the configured depths, so depth is always measured from the current anchor. **Sticky** works keep their neighbors as if still expanded: the previous anchor(s) and works the user expanded with the button. Works the old build reached only through traversal are dropped unless the new build reaches them.
- **Filters:** filters hide nodes from the view. They don't remove nodes from the graph or stop them being fetched. Keep the graph data separate from what is visible.

## Data sources

Combining several citation databases to fill each other's coverage gaps is the app's main value, especially for humanities scholarship that any single source covers poorly. Development starts with one provider (OpenAlex or Semantic Scholar). Design for several from the beginning:

- **Tracer IDs:** each source has its own Tracer ID. A mapping record links it to the source's IDs in each provider (OpenAlex ID, Semantic Scholar ID, DOI, and so on). The client and the database use only Tracer IDs, never a provider's ID as the primary key. Deduplication across paths and across providers goes through this mapping.
- **Provider adapters:** put each external API behind a common interface that returns Tracer's own normalized types. Provider-specific response shapes must not leak outside the adapter.
  - **Implemented:** `server/src/providers/`. `types.js` defines the `Provider` interface (`getWork`, `getWorks`, `getCitingWorks`, `getCitedWorks`, `searchWorks`) and the normalized `ProviderWork` type. `ids.js` has `normalizeDoi`, which every adapter must use so DOIs match across providers. `openalex.js` is the first adapter.
  - Adapters return provider IDs, not Tracer IDs. Each `ProviderWork` carries `externalIds` (DOI and others) for cross-provider matching, and `referencedIds` for drawing in-graph edges without extra requests.
  - Adapters are factories (`createOpenAlexProvider({ apiKey, fetch, sleep })`). Tests inject a fake `fetch` and `sleep`; they never call the real API.
  - **OpenAlex costs** (credits per request): single-work lookup 0, list or filter 1, search 10. The keyless daily budget is 1,000 credits; an `OPENALEX_API_KEY` gives 10 times that. Prefer batched `openalex:A|B|C` filters (up to 100 IDs) over many separate list requests.
  - **Coverage gaps seen:** reference lists are often empty for older humanities articles (e.g. Thompson 1971 has 4,693 citing works but 0 references). Some abstracts are only author and title glued together.
- **Merging:** when providers disagree or one is missing data, merge records and citation edges rather than picking one provider wholesale. Keep track of which provider each piece of data came from.
  - **Not yet implemented.** Only OpenAlex is wired in. `toWorks()` in `server/src/works/workService.js` is where records will be merged. Duplicate `Source`s (e.g. two OpenAlex works with one DOI) are not merged yet either.

## MongoDB roles

1. Cache provider responses, to stay under rate limits and speed up repeat lookups.
2. Save user-built graphs.
3. Maintain an internal database of sources, ID mappings and citations merged from all providers. This merged database is the reason MongoDB is in the stack, not just a cache.

Models are in `server/src/models/`:

- **`Source`:** one per work. Its `_id` is the Tracer ID. It holds `externalIds` (`openalex` is unique; `doi` is indexed but not unique) and `records.<provider> = { data: ProviderWork, fetchedAt }`. A Source with no records is a **stub**. Saving a work upserts a stub for every work it references, so references get Tracer IDs immediately. That keeps edges intact when A is fetched before B, and keeps a Tracer ID stable when a stub is later filled in.
- **`CacheEntry`:** cached list results (citing works, searches) stored as ordered provider IDs under keys like `openalex:citing:W1:50`. A TTL index on `expiresAt` deletes old entries, and reads also check `expiresAt`. Cited lists aren't cached, because a work's own record already has its references.

Refresh intervals (`DEFAULT_TTLS` in `workService.js`): work records 30 days, citing lists 7 days, searches 1 day. If a refresh finds nothing, stale data is served.

Tech stack: Tracer is a MERN app managed as npm workspaces: React 19 + Vite in `client/`, Express 5 + Mongoose in `server/`. It deploys to Heroku as a single dyno. Both packages are ES modules (`"type": "module"`), and Node 24.x is required.

## Commands

Run from the repo root:

```sh
npm install                          # installs all workspaces
docker run -d -p 27017:27017 --name tracer-mongo mongo:8.2   # local MongoDB (first time; then: docker start tracer-mongo)
cp server/.env.example server/.env   # sets PORT, MONGODB_URI, OPENALEX_API_KEY
npm run dev                          # server (:5000, node --watch) + Vite (:5173) via concurrently
npm run build                        # builds client to client/dist
npm start                            # production server (what Heroku runs)
npm test                             # all Vitest tests, run once
npm run test:watch                   # Vitest in watch mode
npm run lint                         # ESLint
npm run format                       # Prettier --write (format:check to verify only)
```

Target one workspace with `-w`, e.g. `npm install <pkg> -w server` or `npm run dev -w client`.

Run a subset of tests:

```sh
npx vitest run --project server                 # one project: client | server
npx vitest run client/src/App.test.jsx          # one file
npx vitest run client/src/App.test.jsx -t "unreachable"   # tests whose name matches
```

Tooling layout: Vitest, ESLint and Prettier are installed at the root. The root `vitest.config.js` lists `client` and `server` as projects, and each has its own `vitest.config.js`. Client tests run in jsdom with Testing Library, and `client/src/test/setup.js` loads the jest-dom matchers. Server tests run in Node and use Supertest against the exported app. Test files sit next to the code they test, as `*.test.js(x)`. ESLint uses one flat config at the root (`eslint.config.js`), and `eslint-config-prettier` turns off formatting rules so Prettier owns formatting.

## Architecture

- **Dev:** two processes. Vite proxies `/api/*` to `http://localhost:5000` (`client/vite.config.js`), so client code always calls relative `/api/...` URLs and never hardcodes a host.
- **Production:** one process. When `NODE_ENV=production` (Heroku sets this by default), Express serves `client/dist` as static files and sends `index.html` for every non-`/api` route as an SPA fallback. New API routes must live under `/api` and be registered _before_ that fallback in `server/src/app.js`.
- **Server entry split:** `server/src/app.js` exports `createApp({ workService })`, which has no side effects. `server/src/index.js` connects to Mongo, builds the OpenAlex provider and work service, and calls `listen`. Tests call `createApp` with their own dependencies.
- **Works API** (`server/src/works/`): `routes.js` is thin; `workService.js` does lookup, caching and Tracer ID translation.
  - `GET /api/works?q=&limit=` searches, returning `{ works }`.
  - `GET /api/works/:id` returns `{ work }`.
  - `GET /api/works/:id/citing?limit=` and `GET /api/works/:id/cited?limit=` return `{ works }`.
  - `:id` may be a Tracer ID, an OpenAlex ID or URL, or a DOI. **DOIs must be URL-encoded**, since they contain `/`.
  - `limit` must be 1–200 and defaults to 50.
  - Responses are client-facing `Work` objects whose `id` and `references` are Tracer IDs.
  - Errors are returned as `{ error }`:

    | Status | Meaning                                        |
    | ------ | ---------------------------------------------- |
    | 400    | Bad ID or bad limit                            |
    | 404    | Work not found                                 |
    | 502    | Provider failure                               |
    | 503    | Provider rate limit, or no database connection |

- **MongoDB version:** use 8.2. MongoDB 8.3+ refuses to start on Linux kernel 6.19 and later ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)), and this dev machine runs kernel 7.0. That's why the Docker image is `mongo:8.2`, and why root `package.json` pins `config.mongodbMemoryServer.version` for tests. Don't bump either to 8.3+ until that bug is fixed.
- **Works tests** (`works.test.js`) use `mongodb-memory-server` (a real `mongod`, downloaded to `~/.cache` on first run) and a fake provider backed by an in-memory catalog. They assert on provider call counts to verify caching, and inject `now` to test expiry.
- **Client** (`client/src/`):
  - **`graph/graphModel.js`:** pure graph logic, independent of React.
    - The graph is `{ anchorId, works: Map, relations: Map, expanded: Map }`.
    - `relations` records how each work joined: `anchor`, `citing` or `cited`.
    - `expanded` records which directions have been fetched for each work.
    - `sticky` holds works that keep their neighbors across re-anchoring. `expandWork` (user expansion) adds to it, and `reanchorGraph` adds the outgoing anchor. Build traversal never makes a work sticky; if it did, re-anchoring could never drop anything.
    - `reanchorGraph` reuses the anchor's data (no `getWork`), runs `buildGraph`, then re-expands each sticky work. Neighbor lists are fetched again rather than tracked, which is cheap because the server caches them. A sticky work the new build didn't reach is recolored relative to the new anchor (`relationTo`).
    - Edges (`deriveEdges`) and node sizes (`inGraphCitationCounts`) are always calculated from `works`, never stored.
    - `buildGraph` runs breadth-first with a separate depth per direction. Levels alternate between directions so `maxNodes` doesn't starve one of them, and requests run with limited concurrency. `expandWork` returns an updater to apply to the latest state.
  - **`graph/useCitationGraph.js`:** holds graph state. A new build or re-anchor aborts the one in progress (`AbortController`). A re-anchor keeps the old graph on screen and swaps in the result once (status `reanchoring`, with `progressCount` for the status line), so kept nodes hold their positions. If it fails, the old graph stays.
  - **Loading progress** (`graph/progress.js`, `components/LoadingProgress.jsx`): builds, re-anchors and expansions each report to a tracker, which counts work in API requests.
    - `plan` adds requests known to be coming. Each real request is timed with `begin()` and its returned finish function. `complete()` marks planned requests that were skipped (for example, when the graph is full), so `done` always reaches `total`.
    - `project` estimates requests on deeper levels from the new works per request seen so far, scaled down to fit `maxNodes`.
    - Time remaining = remaining requests × average request latency ÷ parallelism (4 for builds, 2 for expansions, roughly 3 for re-anchors). Latency is measured per request rather than by wall clock; a wall-clock rate overestimated about 4× while early requests ran one at a time.
    - The hook keeps one entry per task in `tasks`. The visible cards update on every request, but the `role=status` line changes only on start and finish, so screen readers aren't flooded.
  - **`graph/GraphView.jsx`** renders with `react-force-graph-2d` (canvas).
    - Node objects are reused across updates, because force-graph stores positions on them.
    - Filtered-out works stay in the simulation and are hidden through `nodeVisibility`/`linkVisibility`, so filtering doesn't reshuffle the layout.
    - Circle area is proportional to in-graph citations, via `nodeVal`. It must stay `nodeVal`-based so arrowheads land on circle edges.
    - Colors come from CSS custom properties in `App.css`. The canvas resolves them through a hidden probe element and normalizes them to `rgba()` with a 1x1 canvas, because derived tokens compute to `oklab()`/`color()` strings. It re-reads them when the theme changes.
    - Tooltip HTML is escaped, because titles come from external data.
    - **Year layout:** `graph/axis.js` (`axisGeometry(angle)`) converts between screen x/y and axis coordinates: u along the time axis, v across it. A custom `yearForce` pulls each node to its year's u, with only a weak pull across the axis, so works from the same period spread out. `yearPositions` spaces distinct years in order, giving larger gaps logarithmically more room. Faint lines across the axis label the years (`onRenderFramePre`).
    - **Rotation:** the angle lives in `App` state (`ViewPanel` slider). On change, `GraphView` moves every node straight to its rotated position (keeping its u and v), instead of letting the simulation drag nodes there, and refits the view. The force reads the current geometry through a ref, so it never needs replacing.
    - **Tuning:** layout constants sit at the top of `GraphView.jsx`. Years are packed fairly close (`YEAR_SPACING` 15), and repulsion (`CHARGE`) spreads works across the axis. `YEAR_PULL` keeps that repulsion from moving works along it. Measured on a 41-work graph: median distance from a work's year is about 0.4 years, and no works end up out of chronological order.
    - **Forces:** d3's `center` force is removed. It shifts all nodes to keep their average at the origin, which pulls them off their year positions. Links are weak (strength 0.02), because citations always span years and would fight the time axis. Charge has `distanceMax`, so a crowd on one side can't push a node off its year. `forceCollide` stops large circles from overlapping.
    - The view fits once, after the build finishes and the layout settles. Fitting to a partial graph leaves the view zoomed in on one small part of the time axis.
  - **Interaction:** clicking a node selects it and opens `DetailsPanel`; expanding is a button there. The anchor and the selected node always stay visible regardless of filters.
  - **Defaults** (`DEFAULT_OPTIONS` in `App.jsx`): depth 1 each way, 20 works per node, 300 max works. Each extra level multiplies requests, which costs OpenAlex credits.
  - **Theming** (`App.css`): three layers.
    1. Four `--palette-*` slots are the only place colors are defined. Swapping them re-themes everything.
    2. `--ink` and `--paper` are neutrals derived from the palette.
    3. Role tokens (`--bg`, `--accent`, `--node-anchor`, `--graph-link`, …) are derived with `color-mix()`, separately for light and dark.

    Components and canvas code use only role tokens; never put a literal color anywhere else. `accent-color` themes native controls. Light-mode node fills (orange and sage on cream) are below 3:1, so nodes get a `--node-outline` that meets 3:1 on its own. Re-check contrast when changing the palette.

  - **Client tests** mock `GraphView` (jsdom has no canvas) and `api.js`. To check the real canvas, use the `/run-tracer` skill (`.claude/skills/run-tracer/`). It runs an isolated server on :5099 and a headless-browser driver that can select nodes by color and take screenshots.
- **Heroku build:** `npm install`, then `heroku-postbuild` (client build), then the `Procfile` `web: npm start`. The server reads `PORT` from the environment.
- **Database:** the server calls `listen` first, then connects to MongoDB in the background through `connectWithRetry` (`server/src/db.js`), retrying every 5 seconds. Mongoose never retries a failed _initial_ connection by itself. Until it connects, or if `MONGODB_URI` is unset, `/api/works` returns 503. In dev, a closed API port shows up as a bare **502 from Vite's proxy**, not from Express. `bufferCommands` is off, so queries fail fast instead of hanging. `/api/health` reports `db: connected|disconnected`. The dev script loads `server/.env` with `--env-file-if-exists`; there is no dotenv dependency.
- **Express 5:** path syntax differs from Express 4, e.g. the SPA fallback uses a regex rather than `*`. Async route handlers that reject are forwarded to error middleware automatically.

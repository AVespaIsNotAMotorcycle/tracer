# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Tracer builds interactive citation graphs for academic sources, focused on the humanities, especially history. See `README.md` for the user-facing description.

Core model:

- **Node:** a source (article). It is drawn as a circle whose radius scales with its **in-graph** citation count: how many works on the current graph cite it, not its global total. That count changes as the graph grows, so derive it from the edges instead of storing it. This choice may be revisited, so keep the sizing metric easy to swap.
- **Edge:** a directed citation (A cites B). Every known citation between any two nodes on the graph is drawn, not only those involving the root.
- **Graph build:** from a root article, fetch citing works (incoming edges) and cited works (outgoing edges), breadth-first. The two directions have **separate depths**, e.g. citing depth 1 and cited depth 3.
- **Expansion:** clicking a node fetches its citing and cited works and merges them into the existing graph.
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
cp server/.env.example server/.env   # optional; sets PORT and MONGODB_URI
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

- **Works tests** (`works.test.js`) use `mongodb-memory-server` (a real `mongod`, downloaded to `~/.cache` on first run) and a fake provider backed by an in-memory catalog. They assert on provider call counts to verify caching, and inject `now` to test expiry.
- **Heroku build:** `npm install`, then `heroku-postbuild` (client build), then the `Procfile` `web: npm start`. The server reads `PORT` from the environment.
- **Database:** the connection is optional. If `MONGODB_URI` is unset or the connection fails, the server still starts and logs a warning, and `/api/works` returns 503. `bufferCommands` is off, so queries fail fast instead of hanging. `/api/health` reports `db: connected|disconnected`. The dev script loads `server/.env` with `--env-file-if-exists`; there is no dotenv dependency.
- **Express 5:** path syntax differs from Express 4, e.g. the SPA fallback uses a regex rather than `*`. Async route handlers that reject are forwarded to error middleware automatically.

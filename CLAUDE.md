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
- **Merging:** when providers disagree or one is missing data, merge records and citation edges rather than picking one provider wholesale. Keep track of which provider each piece of data came from.

## MongoDB roles

1. Cache provider responses, to stay under rate limits and speed up repeat lookups.
2. Save user-built graphs.
3. Maintain an internal database of sources, ID mappings and citations merged from all providers. This merged database is the reason MongoDB is in the stack, not just a cache.

Tech stack: Tracer is a MERN app managed as npm workspaces: React 19 + Vite in `client/`, Express 5 + Mongoose in `server/`. It deploys to Heroku as a single dyno. Both packages are ES modules (`"type": "module"`), and Node 24.x is required.

## Commands

Run from the repo root:

```sh
npm install                          # installs all workspaces
cp server/.env.example server/.env   # optional; sets PORT and MONGODB_URI
npm run dev                          # server (:5000, node --watch) + Vite (:5173) via concurrently
npm run build                        # builds client to client/dist
npm start                            # production server (what Heroku runs)
```

Target one workspace with `-w`, e.g. `npm install <pkg> -w server` or `npm run dev -w client`.

No test runner or linter is configured yet.

## Architecture

- **Dev:** two processes. Vite proxies `/api/*` to `http://localhost:5000` (`client/vite.config.js`), so client code always calls relative `/api/...` URLs and never hardcodes a host.
- **Production:** one process. When `NODE_ENV=production` (Heroku sets this by default), Express serves `client/dist` as static files and sends `index.html` for every non-`/api` route as an SPA fallback. New API routes must live under `/api` and be registered *before* that fallback in `server/src/index.js`.
- **Heroku build:** `npm install`, then `heroku-postbuild` (client build), then the `Procfile` `web: npm start`. The server reads `PORT` from the environment.
- **Database:** the connection is optional. If `MONGODB_URI` is unset or the connection fails, the server still starts and logs a warning. `/api/health` reports `db: connected|disconnected`. The dev script loads `server/.env` with `--env-file-if-exists`; there is no dotenv dependency.
- **Express 5:** path syntax differs from Express 4, e.g. the SPA fallback uses a regex rather than `*`. Async route handlers that reject are forwarded to error middleware automatically.

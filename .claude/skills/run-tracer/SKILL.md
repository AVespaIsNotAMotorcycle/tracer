---
name: run-tracer
description: Build, run, and drive Tracer (the citation-graph web app). Use when asked to start Tracer, run the app, take a screenshot of the graph UI, click or select nodes, check a UI change in a real browser, smoke-test the /api/works routes, or run its tests.
---

Start an isolated Tracer with `serve.mjs`: an in-memory MongoDB plus the production build, on port 5099. Then drive it in headless Chromium by piping commands to `driver.mjs`, a Playwright REPL.

All paths below are relative to the repo root. The skill's files are in `.claude/skills/run-tracer/`.

## Prerequisites

- **Node 24.x.** It's in `engines`; nvm's `v24.21.0` works.
- **No apt packages.** Playwright's headless Chromium shell ran on Ubuntu 26.04 with nothing extra installed.
- **Network access to api.openalex.org.** The app fetches live citation data.

## Setup (once)

```bash
npm install
npm install --prefix .claude/skills/run-tracer                       # Playwright, kept out of the app's deps
.claude/skills/run-tracer/node_modules/.bin/playwright install chromium   # ~120 MB to ~/.cache/ms-playwright
```

The first server start downloads a MongoDB 8.2.6 binary of about 120 MB to `~/.cache/mongodb-binaries`. After that it's cached.

`server/.env` is optional. If it sets `OPENALEX_API_KEY`, `serve.mjs` loads it; without one you get the small keyless OpenAlex budget (see Gotchas).

## Build

```bash
npm run build      # client -> client/dist, which serve.mjs requires
```

Rebuild after every client change. `serve.mjs` serves `client/dist`, not live source.

## Run (agent path)

Start the server in the background and wait for the database to connect:

```bash
(nohup node .claude/skills/run-tracer/serve.mjs > /tmp/tracer-serve.log 2>&1 &)
timeout 60 bash -c 'until curl -sf localhost:5099/api/health | grep -q "\"connected\""; do sleep 1; done'
```

Drive it. Each line is one command, and each prints a line starting with `ok` or `error`:

```bash
node .claude/skills/run-tracer/driver.mjs <<'EOF'
nav
build W2108070148
select anchor
select citing 2
details
expand
screenshot expanded
set Time axis angle = 60
theme dark
viewport 390 844
screenshot mobile-dark full
errors
quit
EOF
```

Screenshots go to `.claude/skills/run-tracer/out/<name>.png` (gitignored). Set `TRACER_SHOTS=dir` to save them elsewhere. Look at them. A blank canvas means the view fit before the layout settled; see Gotchas.

| command                                 | what it does                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav [path]`                            | Open the app                                                                                                                                        |
| `build <DOI or OpenAlex ID>`            | Build a graph. Waits for the build to finish and the layout to settle (about 6 s), then prints `Showing N of N`                                     |
| `search <query>` / `pick [n]`           | Title search with a numbered result list, then build from result n                                                                                  |
| `start <id>` / `progress`               | Start a build without waiting, then print the loading-progress cards (requests, works, time left)                                                   |
| `set <label> = <value>`                 | Fill any input, select or slider by its label, e.g. `set Cited depth = 0`, `set Time axis angle = 60`, `set Article = off` (checkboxes take on/off) |
| `select [anchor\|citing\|cited] [n]`    | Select the nth visible node of that kind (top-left first), using the app's automation hook                                                          |
| `select-title <text>`                   | Select the visible node whose title contains the text                                                                                               |
| `select-at [fx fy]`                     | Fallback: click the node nearest a canvas point, given as fractions of its size                                                                     |
| `details`                               | Print the details panel text                                                                                                                        |
| `expand`                                | Expand the selected node and wait                                                                                                                   |
| `reanchor`                              | Make the selected node the anchor; waits for the rebuild and layout settle                                                                          |
| `click <button name>`                   | Click a button by its accessible name                                                                                                               |
| `theme light\|dark`, `viewport <w> <h>` | Switch color scheme, resize                                                                                                                         |
| `screenshot [name] [full]`              | Save a PNG; add `full` for the whole page                                                                                                           |
| `eval <js>`                             | Run JS in the page and print the result as JSON                                                                                                     |
| `errors`                                | Console and page errors so far. Check this before declaring success                                                                                 |
| `wait [ms]`, `help`, `quit`             |                                                                                                                                                     |

Good test anchors:

- **`W2108070148`** (_Manchus and Han_, 2001): about 41 works in both directions.
- **`10.1093/past/50.1.76`** (Thompson, 1971): 21 works, all citing. OpenAlex has none of its references.

API smoke test without a browser. DOIs must be URL-encoded:

```bash
curl -s "localhost:5099/api/works/$(node -p "encodeURIComponent('10.1093/past/50.1.76')")/citing?limit=3"
```

Stop the server:

```bash
kill $(lsof -ti:5099 -sTCP:LISTEN)
```

## Direct invocation (no app)

Graph logic is pure ESM with no React or DOM dependencies. Import it and call it directly:

```bash
node --input-type=module -e "
import { addWorks, emptyGraph, layoutYears } from './client/src/graph/graphModel.js';
const w = (id, references, year) => ({ id, references, year });
const g = { ...addWorks(emptyGraph(), [w('N', ['U'], 1971), w('U', [], null)], 'cited'), anchorId: 'N' };
console.log(Object.fromEntries(layoutYears(g)));
"
```

The OpenAlex adapter, called against the live API:

```bash
node --env-file-if-exists=server/.env --input-type=module -e "
import { createOpenAlexProvider } from './server/src/providers/openalex.js';
const p = createOpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
console.log(await p.getWork('10.1093/past/50.1.76'));
"
```

## Run (human path)

```bash
docker start tracer-mongo || docker run -d -p 27017:27017 --name tracer-mongo mongo:8.2
npm run dev        # API :5000 (node --watch), Vite :5173 proxying /api. Ctrl-C to stop.
```

## Test

```bash
npm test           # Vitest: client (jsdom) + server (mongodb-memory-server); 125 tests
npm run lint
```

Client tests mock `GraphView`, because jsdom has no canvas. Canvas behavior (layout, colors, selection) can only be checked with the driver.

## Gotchas

- **The developer may already be running `npm run dev` on 5000/5173.** Don't kill it or reuse those ports. That's why `serve.mjs` uses 5099 in production mode, with its own in-memory database. If you edit `server/src/*`, their `node --watch` restarts their server; that's expected.
- **Nodes are canvas pixels, not DOM elements.** With `?automation` in the URL (`nav` adds it), `GraphView` exposes `window.__tracerAutomation.nodes()`: each visible node's id, relation, title, type, screen x/y and radius. `select` and `select-title` click those exact points. I first tried finding nodes by their fill color, but source-type icons split each circle into fragments, and no fixed pixel threshold worked across zoom levels. Use the hook. "nth" is raster order and **changes between runs**, because the force layout isn't deterministic, so prefer `select-title` when you need a specific work. Off-screen nodes aren't counted.
- **Opening the details panel resizes the canvas from 1,080px to 720px over a few hundred ms.** Scanning or clicking mid-resize misses. The driver waits for the resize to start, then for it to settle. If you write your own clicks, do the same, or the second selection in a row fails with `click did not select a node`.
- **The view fits only after the build finishes and the layout settles.** `build` and `pick` wait 6 s. Screenshots taken sooner show an unfitted view, such as long link lines with no nodes.
- **Title search finds duplicates.** "Manchus and Han" returns three separate records: two 2015 book records with almost no citation data, and the 2001 Choice review that has it. Prefer `build <ID>` for repeatable runs.
- **OpenAlex budget.** Without a key you get 1,000 credits a day: a search costs 10, a list request 1 and a single-work lookup 0. Each driver `build` uses a few. The server caches in its in-memory database, so repeat builds in the same server run are free. Restarting `serve.mjs` loses that cache.
- **MongoDB 8.3+ refuses to start on Linux kernel 6.19 and later** ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)). The tests' in-memory server is pinned to 8.2.6 in the root `package.json`, and the Docker image must be `mongo:8.2`, not `mongo:8`.
- **Theme tokens compute to `oklab()`/`color()` strings,** not `rgb()`, because they're built with `color-mix()`. Don't parse `getComputedStyle().color` with a regex. Paint the color on a 1x1 canvas and read the pixel back, as `driver.mjs` and `GraphView` do.
- **npm 11 skips install scripts by default** (`npm warn install-scripts`), so `mongodb-memory-server`'s postinstall doesn't run. That's harmless: it downloads `mongod` on first use instead.

## Troubleshooting

- **`client/dist is missing; run npm run build first.`** (from `serve.mjs`): build first.
- **`error select: click did not select a node`:** the click landed during a canvas resize or between circles. Retry, or follow it with `wait 1000`. If it persists, take a screenshot and check that the node kind is actually visible.
- **`error select: no citing nodes visible`:** that kind isn't on screen. Thompson has no cited works, and filters may hide nodes.
- **`/api/works` returns `{"error":"Database unavailable"}` (503):** MongoDB isn't connected yet. Poll `/api/health` until it reports `"db":"connected"`.
- **A bare 502 from `localhost:5173/api/...`:** that's Vite's proxy, meaning the developer's API on :5000 isn't listening. Not related to this skill's server.
- **`docker start tracer-mongo` exits immediately with "kernel versions 6.19 and newer has a known incompatibility":** the container was created from `mongo:8`. Recreate it from `mongo:8.2`.

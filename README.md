# Tracer

Tracer maps citation networks for academic work, with a focus on the humanities and especially history.

Start from a work (search by title, or paste a DOI or OpenAlex ID) and Tracer builds a graph of the works it cites and the works that cite it, out to depths you choose for each direction. Edges also connect any of those works that cite each other, so you can see how a body of scholarship fits together, not just how it relates to your starting point.

No single citation database covers the humanities well. Tracer combines several (see [Data sources](#data-sources)), so that each fills gaps in the others.

- **Read it in time:** works are laid out along a time axis, older toward the top left and newer toward the bottom right. You can rotate the axis from horizontal to vertical. Years near your starting work get more room. A listed year that the work's own citers predate (usually a reprint or digitization date) is set aside, and the work is placed before its earliest citer.
- **Gauge influence:** each work is a circle sized by how often it's cited overall, on a log scale so classics don't dwarf everything else.
- **Explore:** select a work to see its details, then expand it to pull in its own citing and cited works. You can collapse it again later. Any work can also become the new anchor; the graph is rebuilt around it, keeping the works you expanded.
- **Filter:** hide works by year range, by how many works on the graph they're linked to, or by type (article, book, review, …). Filtering only changes what's shown, not what's fetched.
- **Books and chapters:** a book's chapters are folded into the book and listed in its details, with their citations moved onto it.
- **Works not on OpenAlex:** references that no citation database has (archival sources, older or non-English books) still appear, as grey nodes, with the citation as printed.
- **Find a copy:** a work's details link to it on OpenAlex, its DOI, the publisher's page, an open-access PDF when there is one, and copies on the Internet Archive (free to read, to borrow, or for print-disabled readers).
- **Share:** the URL names the starting work and any non-default options, so a link rebuilds the same graph.
- **Accounts and saved graphs:** sign up with an email and password, save a graph (with its expansions, filters and view) under a name, and reopen, rename or delete it from "My graphs". A saved graph reopens from a stored copy for a week before being rebuilt with fresh data.

## Data sources

| Provider                                   | What Tracer uses it for                                                                                                                                                                                                     | License | Configuration                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| [OpenAlex](https://openalex.org)           | The main source: search, work records (titles, authors, years, types, abstracts, citation counts), citing works and reference lists.                                                                                        | CC0     | `OPENALEX_API_KEY` (optional, recommended) |
| [Crossref](https://www.crossref.org)       | Reference lists deposited by publishers. References OpenAlex has but didn't link become ordinary works; the rest (archival sources, older books) appear as grey "Not on OpenAlex" nodes. Coverage depends on the publisher. | Open    | `CROSSREF_MAILTO` (optional)               |
| [OpenCitations](https://opencitations.net) | Open citation links in both directions, recovering some citations between works that OpenAlex has but doesn't link.                                                                                                         | CC0     | `OPENCITATIONS_ACCESS_TOKEN` (optional)    |
| [Internet Archive](https://archive.org)    | Links to scanned copies of a work, matched by title and author when its details are opened. Not used for citation data.                                                                                                     | Links   | None                                       |

Everything works without the optional settings. The OpenAlex key raises its daily request budget tenfold, and the Crossref address moves requests to Crossref's faster pool. Set them in `server/.env` locally, or as Heroku config vars in production. Responses are cached in MongoDB, so repeat lookups don't call the providers again.

## Stack

MERN app: React 19 (Vite) frontend in `client/`, Express 5 + Mongoose backend in `server/`, managed as npm workspaces. Requires Node 24.

## Development

Tracer needs a MongoDB database. The quickest way to get one locally is Docker:

```sh
docker run -d -p 27017:27017 --name tracer-mongo mongo:8.2   # first time
docker start tracer-mongo                                  # after a reboot
```

Use `mongo:8.2`, not `mongo:8` or newer. MongoDB 8.3+ refuses to start on Linux kernel 6.19 and later ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)).

Then:

```sh
npm install
cp server/.env.example server/.env   # set OPENALEX_API_KEY; MONGODB_URI defaults to the container above
npm run dev                          # API on :5000, Vite on :5173 (proxies /api)
```

The server starts without MongoDB and connects as soon as it's available, retrying every 5 seconds. Until then, the works, account and saved-graph APIs return 503 "Database unavailable".

Other commands:

```sh
npm test               # all tests (Vitest), once; npm run test:watch to watch
npm run lint           # ESLint
npm run format         # Prettier; npm run format:check to only check
npm run build          # builds the client to client/dist
```

Tests don't need a database: they start their own in-memory MongoDB, and never call the real providers.

## Deploying to Heroku

```sh
heroku create
heroku config:set MONGODB_URI="<your MongoDB Atlas connection string>"
heroku config:set OPENALEX_API_KEY=… CROSSREF_MAILTO=…   # optional, see Data sources
git push heroku main
```

On deploy, Heroku runs `npm install` and `heroku-postbuild` (builds the client), then starts the `web` process from the `Procfile`. In production, Express serves `client/dist` and handles `/api/*`. Session cookies are marked Secure in production, so accounts need HTTPS, which Heroku provides.

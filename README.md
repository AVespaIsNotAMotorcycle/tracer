# Tracer

Tracer maps citation networks for academic work, with a focus on the humanities and especially history.

Start from an article and Tracer builds a graph of the works it cites and the works that cite it, out to a depth you choose. Edges also connect any of those works that cite each other, so you can see how a body of scholarship fits together, not just how it relates to your starting point.

No single citation database covers the humanities well. Tracer combines several (see [Data sources](#data-sources)), so that each fills gaps in the others.

- **Explore:** click a node to pull in its own citing and cited works and grow the graph from there.
- **Gauge influence:** each source is drawn as a circle sized by its citation count.
- **Inspect:** select a node to see details about the source, with external links.

## Data sources

| Provider                                   | What Tracer uses it for                                                                                                                                                                                                     | License | Configuration                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------ |
| [OpenAlex](https://openalex.org)           | The main source: search, work records (titles, authors, years, types, abstracts, citation counts), citing works and reference lists.                                                                                        | CC0     | `OPENALEX_API_KEY` (optional, recommended) |
| [Crossref](https://www.crossref.org)       | Reference lists deposited by publishers. References OpenAlex has but didn't link become ordinary works; the rest (archival sources, older books) appear as grey "Not on OpenAlex" nodes. Coverage depends on the publisher. | Open    | `CROSSREF_MAILTO` (optional)               |
| [OpenCitations](https://opencitations.net) | Open citation links in both directions, recovering some citations between works that OpenAlex has but doesn't link.                                                                                                         | CC0     | `OPENCITATIONS_ACCESS_TOKEN` (optional)    |

Everything works without the optional settings. The OpenAlex key raises its daily request budget tenfold, and the Crossref address moves requests to Crossref's faster pool. Set them in `server/.env` locally, or as Heroku config vars in production. Responses are cached in MongoDB, so repeat lookups don't call the providers again.

## Stack

MERN app: React (Vite) frontend in `client/`, Express + Mongoose backend in `server/`, managed as npm workspaces.

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

The server starts without MongoDB and connects as soon as it's available, retrying every 5 seconds. Until then, `/api/works` returns 503 "Database unavailable". Tests don't need it, because they start their own in-memory MongoDB.

## Deploying to Heroku

```sh
heroku create
heroku config:set MONGODB_URI="<your MongoDB Atlas connection string>"
git push heroku main
```

On deploy, Heroku runs `npm install` and `heroku-postbuild` (builds the client), then starts the `web` process from the `Procfile`. In production, Express serves `client/dist` and handles `/api/*`.

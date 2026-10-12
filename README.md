# Tracer

Tracer maps citation networks for academic work, with a focus on the humanities and especially history.

Start from an article and Tracer builds a graph of the works it cites and the works that cite it, out to a depth you choose. Edges also connect any of those works that cite each other, so you can see how a body of scholarship fits together, not just how it relates to your starting point.

No single citation database covers the humanities well. Tracer aims to combine several, starting with OpenAlex and Semantic Scholar, so that each fills gaps in the others.

- **Explore:** click a node to pull in its own citing and cited works and grow the graph from there.
- **Gauge influence:** each source is drawn as a circle sized by its citation count.
- **Inspect:** select a node to see details about the source, with external links.

## Stack

MERN app: React (Vite) frontend in `client/`, Express + Mongoose backend in `server/`, managed as npm workspaces.

## Development

```sh
npm install
cp server/.env.example server/.env   # optional; set MONGODB_URI
npm run dev                          # API on :5000, Vite on :5173 (proxies /api)
```

## Deploying to Heroku

```sh
heroku create
heroku config:set MONGODB_URI="<your MongoDB Atlas connection string>"
git push heroku main
```

On deploy, Heroku runs `npm install` and `heroku-postbuild` (builds the client), then starts the `web` process from the `Procfile`. In production, Express serves `client/dist` and handles `/api/*`.

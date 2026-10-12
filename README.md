# Tracer

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

// Starts an isolated Tracer for agents: an in-memory MongoDB plus the production server
// (Express serving client/dist and /api on one port). Leaves the developer's own
// `npm run dev` (ports 5000/5173) and local MongoDB untouched.
//
// Usage (from the repo root, after `npm run build`):
//   node .claude/skills/run-tracer/serve.mjs [port]     # default 5099
//
// Reads OPENALEX_API_KEY from server/.env if present. Stop with Ctrl-C or kill the port.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envFile = resolve(repo, 'server/.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (!existsSync(resolve(repo, 'client/dist/index.html'))) {
  console.error('client/dist is missing; run `npm run build` first.');
  process.exit(1);
}

const mongo = await MongoMemoryServer.create();
process.env.MONGODB_URI = mongo.getUri('tracer');
process.env.PORT = process.argv[2] ?? '5099';
process.env.NODE_ENV = 'production';

const stop = async () => {
  await mongo.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await import(resolve(repo, 'server/src/index.js'));

import mongoose from 'mongoose';
import { createApp } from './app.js';
import { connectWithRetry } from './db.js';
import { createOpenAlexProvider } from './providers/openalex.js';
import { createWorkService } from './works/workService.js';

const port = process.env.PORT || 5000;

// Fail fast instead of queueing queries while disconnected; routes report 503 instead.
mongoose.set('bufferCommands', false);

if (!process.env.OPENALEX_API_KEY) {
  console.warn('OPENALEX_API_KEY not set; using the small keyless OpenAlex budget');
}

const provider = createOpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
const app = createApp({ workService: createWorkService({ provider }) });

// Listen first so the API is reachable while MongoDB connects (or is down).
app.listen(port, () => console.log(`Server listening on port ${port}`));

if (process.env.MONGODB_URI) {
  connectWithRetry(process.env.MONGODB_URI).then(() => {
    // Attached after the first connection: failed initial attempts also emit 'disconnected'.
    mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
    mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));
  });
} else {
  console.warn('MONGODB_URI not set; skipping database connection');
}

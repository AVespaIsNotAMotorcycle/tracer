import mongoose from 'mongoose';
import { createApp } from './app.js';
import { createOpenAlexProvider } from './providers/openalex.js';
import { createWorkService } from './works/workService.js';

const port = process.env.PORT || 5000;

// Fail fast instead of queueing queries while disconnected; routes report 503 instead.
mongoose.set('bufferCommands', false);

if (process.env.MONGODB_URI) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
  }
} else {
  console.warn('MONGODB_URI not set; skipping database connection');
}

if (!process.env.OPENALEX_API_KEY) {
  console.warn('OPENALEX_API_KEY not set; using the small keyless OpenAlex budget');
}

const provider = createOpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
const app = createApp({ workService: createWorkService({ provider }) });

app.listen(port, () => console.log(`Server listening on port ${port}`));

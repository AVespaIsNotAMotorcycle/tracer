import mongoose from 'mongoose';
import { createApp } from './app.js';
import { createAuthService } from './auth/authService.js';
import { connectWithRetry } from './db.js';
import { createCrossrefProvider } from './providers/crossref.js';
import { createInternetArchiveProvider } from './providers/internetarchive.js';
import { createOpenAlexProvider } from './providers/openalex.js';
import { createOpenCitationsProvider } from './providers/opencitations.js';
import { createWikidataProvider } from './providers/wikidata.js';
import { createWorkService } from './works/workService.js';

const port = process.env.PORT || 5000;

// Fail fast instead of queueing queries while disconnected; routes report 503 instead.
mongoose.set('bufferCommands', false);

if (!process.env.OPENALEX_API_KEY) {
  console.warn('OPENALEX_API_KEY not set; using the small keyless OpenAlex budget');
}

const provider = createOpenAlexProvider({ apiKey: process.env.OPENALEX_API_KEY });
// Crossref supplies the reference lists publishers deposited, including references OpenAlex
// couldn't match. A contact address moves requests to Crossref's faster polite pool.
const referenceProvider = createCrossrefProvider({ mailto: process.env.CROSSREF_MAILTO });
// OpenCitations supplies open citation links, recovering some that OpenAlex doesn't have.
const linkProvider = createOpenCitationsProvider({
  accessToken: process.env.OPENCITATIONS_ACCESS_TOKEN,
});
// The Internet Archive: scanned copies of works, linked from their details.
const archiveProvider = createInternetArchiveProvider();
// Wikidata: authors' names in their own scripts, and links to them. Wikimedia throttles
// clients that don't give a contact address.
if (!process.env.WIKIDATA_CONTACT) {
  console.warn('WIKIDATA_CONTACT not set; Wikidata may throttle requests');
}
const nameProvider = createWikidataProvider({ contact: process.env.WIKIDATA_CONTACT });
const app = createApp({
  workService: createWorkService({
    provider,
    referenceProvider,
    linkProvider,
    archiveProvider,
    nameProvider,
  }),
  authService: createAuthService(),
  // Session cookies only over HTTPS in production (Heroku serves HTTPS).
  authOptions: { secureCookies: process.env.NODE_ENV === 'production' },
});

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

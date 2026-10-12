import mongoose from 'mongoose';

// Cached provider list results (citing works, searches) as ordered provider IDs. The work data
// itself lives on Source records.
const cacheEntrySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  providerIds: { type: [String], default: [] },
  expiresAt: { type: Date, required: true },
});

// MongoDB deletes expired entries in the background (roughly once a minute), so reads must
// still check expiresAt.
cacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CacheEntry = mongoose.model('CacheEntry', cacheEntrySchema);

import mongoose from 'mongoose';

/** Reading statuses a work can have in a user's library, in reading order. */
export const READING_STATUSES = ['to-read', 'reading', 'read', 'cited'];

// A work in a user's library, with its reading status: one per user and work (Tracer ID).
// The library is the user's own, across all their graphs: "I've read this" is true wherever the
// work appears. Notes stay on each saved graph (SavedGraph annotations); the library page lists
// them alongside.
const libraryEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    workId: { type: String, required: true },
    status: { type: String, enum: READING_STATUSES, required: true },
  },
  { timestamps: true },
);

libraryEntrySchema.index({ userId: 1, workId: 1 }, { unique: true });
libraryEntrySchema.index({ userId: 1, updatedAt: -1 });

export const LibraryEntry = mongoose.model('LibraryEntry', libraryEntrySchema);

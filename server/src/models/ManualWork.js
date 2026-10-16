import mongoose from 'mongoose';

/** Kinds of work a user can add by hand (OpenAlex's names, so icons and filters match). */
export const MANUAL_WORK_TYPES = ['book', 'article', 'book-chapter', 'dissertation', 'other'];

// A work a user added by hand because no database has it: an archival source, a pamphlet, an
// unpublished thesis. Visible only to that user. Its _id serves as its Tracer ID in the client
// (ObjectIds don't collide with Sources'), but it isn't a Source: Sources are shared by
// everyone, and this is the user's own.
const manualWorkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, maxlength: 500 },
    authors: { type: [String], default: [] },
    year: Number,
    type: { type: String, enum: MANUAL_WORK_TYPES, default: 'other' },
    venue: { type: String, maxlength: 300 },
    doi: String,
  },
  { timestamps: true },
);

manualWorkSchema.index({ userId: 1, createdAt: 1 });

export const ManualWork = mongoose.model('ManualWork', manualWorkSchema);

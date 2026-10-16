import mongoose from 'mongoose';

// A citation a user added by hand ("I read this footnote"): `citingId` cites `citedId`, each a
// Tracer ID (a Source) or one of the user's ManualWorks. Visible only to that user; the client
// lays it over the graph as a link from the provider `manual`.
const manualLinkSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    citingId: { type: String, required: true },
    citedId: { type: String, required: true },
  },
  { timestamps: true },
);

manualLinkSchema.index({ userId: 1, citingId: 1, citedId: 1 }, { unique: true });

export const ManualLink = mongoose.model('ManualLink', manualLinkSchema);

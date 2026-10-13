import mongoose from 'mongoose';

// A saved graph as last built (its works, relations, expansions), so reopening it needn't
// fetch every work again. One per saved graph, sharing its _id. `key` identifies the saved
// state it was built from (graphService's stateKey): once the graph is saved with a different
// anchor, options or expansions, the snapshot no longer applies. `data` is gzipped JSON, since
// works' reference lists make it large (and they compress well).
const graphSnapshotSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedGraph' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  key: { type: String, required: true },
  data: { type: Buffer, required: true },
  builtAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});

// MongoDB deletes expired snapshots in the background (roughly once a minute), so reads must
// still check expiresAt.
graphSnapshotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const GraphSnapshot = mongoose.model('GraphSnapshot', graphSnapshotSchema);

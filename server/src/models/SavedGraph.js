import mongoose from 'mongoose';

// Markup on a saved graph: a note now, other kinds (highlights, colours, tags) later. Each one
// targets either the whole graph or one work (by Tracer ID), so notes on works and on the graph
// share one list and one shape. Not editable yet; saved graphs start with none.
const annotationSchema = new mongoose.Schema(
  {
    target: {
      type: { type: String, enum: ['graph', 'work'], required: true },
      workId: String, // For 'work': the work's Tracer ID.
    },
    kind: { type: String, enum: ['note'], required: true },
    body: { type: String, maxlength: 10_000 },
  },
  { timestamps: true },
);

// A graph a user saved. Its _id is the ID used to open it (/?graph=<id>). It stores what's
// needed to rebuild the graph, not the works themselves: the anchor, the build options, the
// works the user expanded (in order, since a later expansion can depend on an earlier one's
// works), and the filters and view, so it reopens as it was left.
const savedGraphSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, maxlength: 120 },
    // Bumped if the stored shape changes, so old saves can be read.
    version: { type: Number, default: 1 },
    anchor: {
      id: { type: String, required: true }, // Tracer ID.
      ref: String, // DOI or OpenAlex ID: still meaningful if Tracer IDs change.
      title: String,
    },
    options: { citingDepth: Number, citedDepth: Number, limit: Number, maxNodes: Number },
    filters: {
      minYear: Number,
      maxYear: Number,
      minConnections: Number,
      excludedTypes: [String],
    },
    // Pinned works (Tracer IDs) are always shown, whatever the filters.
    view: { axisAngle: Number, pinned: [String] },
    expanded: [String],
    annotations: { type: [annotationSchema], default: [] },
  },
  { timestamps: true },
);

savedGraphSchema.index({ userId: 1, updatedAt: -1 });

export const SavedGraph = mongoose.model('SavedGraph', savedGraphSchema);

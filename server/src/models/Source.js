import mongoose from 'mongoose';

// A source (work) in Tracer's internal database. Its _id is the Tracer ID that the client and
// saved graphs use. `externalIds` maps it to each provider's IDs, and `records` holds each
// provider's normalized data (a ProviderWork) keyed by provider name.
//
// A source with no records is a stub: a work some other work cites, which hasn't been fetched
// yet. Stubs exist so every reference has a Tracer ID as soon as it is seen.
//
// A reference-only source is a work known only from another work's reference list (as
// deposited with Crossref) that no citation database has: an archival source, say. It has no
// records; `citation` holds the reference as deposited, and `externalIds.citation` a key
// built from it (citationKey), so works citing the same thing share one source.
// `citationMatch` caches what Crossref's citation search found for it.
//
// A merged source is a duplicate of another (works/merges.js): `mergedInto` is the source it
// now lives in, and every lookup of its Tracer ID or provider IDs is redirected there. It
// keeps its IDs and records, so lookups still find it and the canonical source can combine
// its citations. Redirects are one hop: merging a source repoints those merged into it.
const sourceSchema = new mongoose.Schema(
  {
    externalIds: {
      openalex: String,
      doi: String,
      pmid: String,
      mag: String,
      citation: String,
    },
    citation: mongoose.Schema.Types.Mixed,
    // For a reference-only source: the work Crossref's citation search matched it to
    // (a CrossrefWork), or null for none, and when that was looked up.
    // `mergeChecked`: whether the match was looked up on the provider, to merge into it.
    citationMatch: { data: mongoose.Schema.Types.Mixed, fetchedAt: Date, mergeChecked: Boolean },
    mergedInto: { type: mongoose.Schema.Types.ObjectId, ref: 'Source' },
    mergedAt: Date,
    // Why: 'doi' (same DOI) or 'citation-match' (a reference-only work Crossref matched).
    mergeReason: String,
    records: {
      type: Map,
      of: new mongoose.Schema(
        { data: mongoose.Schema.Types.Mixed, fetchedAt: Date },
        { _id: false },
      ),
      default: {},
    },
    createdAt: Date,
  },
  { minimize: false },
);

sourceSchema.index(
  { 'externalIds.openalex': 1 },
  { unique: true, partialFilterExpression: { 'externalIds.openalex': { $type: 'string' } } },
);
sourceSchema.index(
  { 'externalIds.citation': 1 },
  { unique: true, partialFilterExpression: { 'externalIds.citation': { $type: 'string' } } },
);
// Not unique: OpenAlex sometimes has several works with the same DOI (they're merged; see
// works/merges.js).
sourceSchema.index({ 'externalIds.doi': 1 });
// Finds the sources merged into one, to combine their citations.
sourceSchema.index({ mergedInto: 1 }, { sparse: true });

export const Source = mongoose.model('Source', sourceSchema);

// OpenAlex work types Tracer recognizes, with no UI dependencies, so graph logic (filtering)
// and the UI (icons, labels in sourceTypes.js) group types the same way.

export const SOURCE_TYPE_KEYS = [
  'article',
  'book',
  'book-chapter',
  'book-review',
  'review',
  'conference-paper',
  'conference-abstract',
  'dissertation',
  'preprint',
  'report',
  'dataset',
  'data-paper',
  'editorial',
  'letter',
  'reference-entry',
  'erratum',
  'retraction',
  'paratext',
  'peer-review',
  'standard',
  'software',
  'software-paper',
  'supplementary-materials',
  'libguides',
  'reference-only',
  'other',
];

/**
 * Type of a work known only from another work's reference list, which no citation database
 * has (e.g. an archival source). The server assigns it; such works can't be expanded.
 */
export const REFERENCE_ONLY = 'reference-only';

const KNOWN = new Set(SOURCE_TYPE_KEYS);

/** A work's type key; unknown or missing types are grouped as 'other'. */
export function sourceTypeKey(type) {
  return type && KNOWN.has(type) ? type : 'other';
}

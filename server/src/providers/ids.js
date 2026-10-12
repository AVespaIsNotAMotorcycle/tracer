const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;

/**
 * Normalize a DOI to its bare, lowercase form ("10.1234/abc"), stripping any URL or "doi:"
 * prefix. DOIs are case-insensitive, so lowercasing makes them safe to compare across
 * providers. Returns null if the input isn't a DOI.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeDoi(value) {
  if (!value) return null;
  const bare = value
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
  return DOI_PATTERN.test(bare) ? bare : null;
}

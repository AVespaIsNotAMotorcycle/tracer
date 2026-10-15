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

const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;

/**
 * Normalize a language tag to its lowercase primary subtag, an ISO 639 code ("zh-CN" → "zh",
 * "FR" → "fr"), so codes match across providers. Returns null if it isn't one.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_PATTERN.test(primary) ? primary : null;
}

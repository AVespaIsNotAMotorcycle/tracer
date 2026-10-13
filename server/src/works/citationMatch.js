// Matching a reference that no citation database linked (a reference-only work) to a work
// Crossref has, from Crossref's citation search. The search always returns something, often a
// review of the book cited or another work with the same title, and its scores can't be
// compared between queries, so each candidate is checked: same title, same first author, and
// a year at most one off. Reviews are the main trap: they carry the book's title, and JSTOR's
// records of them list the book's authors after the reviewer, while Choice's list nobody. So
// the cited author must come first, a candidate without authors only matches a reference
// without them, and a book can't match a journal article.

import { fullTitle, mainTitle, squash, surname } from './textMatch.js';

/** @typedef {import('../providers/types.js').ProviderReference} ProviderReference */
/** @typedef {import('../providers/crossref.js').CrossrefWork} CrossrefWork */

// A title found inside a citation printed as text must be at least this long (squashed), so a
// one-word title ("Japan") isn't found by chance.
const MIN_TITLE_IN_TEXT = 8;
// Without an author to compare, only a long title is trusted.
const MIN_TITLE_ALONE = 20;
const MAX_YEAR_GAP = 1;

const JSTOR_DOI_PREFIX = '10.2307/';

/** JSTOR's DOIs (10.2307/…) resolve to JSTOR, for articles and books it digitized itself. */
export const isJstorDoi = (doi) => Boolean(doi?.toLowerCase().startsWith(JSTOR_DOI_PREFIX));

/** Links for a DOI: the DOI itself, and JSTOR's stable URL when it's a JSTOR DOI. */
export function doiLinks(doi) {
  const links = [{ kind: 'doi', url: `https://doi.org/${doi}` }];
  if (isJstorDoi(doi)) links.push({ kind: 'jstor', url: `https://www.jstor.org/stable/${doi}` });
  return links;
}

/**
 * The text to search Crossref for: the citation as printed, or one assembled from its fields.
 * Null when there's no title to search on.
 *
 * @param {ProviderReference} citation
 */
export function citationQuery(citation) {
  if (citation.unstructured) return citation.unstructured;
  if (!citation.title) return null;
  const names = (citation.authors ?? []).map((author) => author.name);
  return [...names, citation.title, citation.venue, citation.year].filter(Boolean).join(' ');
}

/**
 * Whether two squashed surnames are the same, allowing a particle on one side only ("devries"
 * and "vries"). The shorter must be 4+ letters to compare by ending, so "li" isn't "bali".
 */
function sameSurname(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.endsWith(shorter);
}

const familyOf = (author) => squash(author.family) || surname(author.name);

/**
 * The first candidate that is the work `citation` refers to, or null.
 *
 * @param {ProviderReference} citation
 * @param {CrossrefWork[]} candidates  Best first, as Crossref ranks them.
 * @returns {CrossrefWork | null}
 */
export function matchCitation(citation, candidates) {
  const text = citation.title ? null : squash(citation.unstructured);
  const author = surname(citation.authors?.[0]?.name);
  return (
    candidates.find((candidate) => {
      const main = mainTitle(candidate.title);
      if (!main) return false;

      // Title: the same as the reference's, or found in the citation as printed.
      if (citation.title) {
        if (
          main !== mainTitle(citation.title) &&
          fullTitle(candidate.title) !== fullTitle(citation.title)
        ) {
          return false;
        }
      } else if (!text || main.length < MIN_TITLE_IN_TEXT || !text.includes(main)) {
        return false;
      }

      if (
        citation.year &&
        candidate.year &&
        Math.abs(citation.year - candidate.year) > MAX_YEAR_GAP
      ) {
        return false;
      }

      // A reference with a title but no journal is to a book (or a chapter, whose book is its
      // venue), so a journal article with that title is a review of it.
      if (citation.title && !citation.venue && candidate.type === 'journal-article') return false;

      // Author: the reference's first author is the candidate's, or the candidate's first
      // author is named in the citation as printed.
      const first = candidate.authors[0] && familyOf(candidate.authors[0]);
      if (first) {
        if (author) return sameSurname(first, author);
        return Boolean(text?.includes(first));
      }
      // No authors to compare: only for a reference without them either, on a long title with a
      // year that agrees.
      return (
        !author &&
        !text &&
        Boolean(citation.year && candidate.year) &&
        main.length >= MIN_TITLE_ALONE
      );
    }) ?? null
  );
}

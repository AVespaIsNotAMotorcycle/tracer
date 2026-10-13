// Matching a work to Internet Archive items. The Archive has no DOIs for most books, so this
// goes by title and author: the main title (before any subtitle) must be the same, and the
// first author's surname must be among the item's creators. Different editions of a book are
// all matches.
//
// A reference deposited only as printed text has no title or author fields, and might be a
// note citing several works, an archival source, or "op. cit.". Its distinctive words are
// searched across the Archive's metadata instead, and an item matches if its main title and a
// creator's surname both appear in the text.

import { fullTitle, mainTitle, squash, surname, withoutNotes } from './textMatch.js';

/** @typedef {import('../providers/internetarchive.js').ArchiveItem} ArchiveItem */

// Words too common to search on. Matching still compares whole titles.
const STOPWORDS = new Set(
  'a an and the of in on to for or not der die das und von la le les de des et il el y'.split(' '),
);
// Words in printed citations that aren't the work's title or author: page and edition
// markers, cross-references, and the commonest places and publishers.
const CITATION_WORDS = new Set(
  (
    'pp ed eds edn trans transl vol vols op cit ibid idem quoted cited see also esp ' +
    'unpublished thesis dissertation phd press university london new york paris oxford ' +
    'cambridge berlin leiden amsterdam'
  ).split(' '),
);
const MAX_SEARCH_WORDS = 8;
// A title found inside a printed citation must be at least this long (squashed), so a short
// title ("Japan") isn't found by chance.
const MIN_TITLE_IN_TEXT = 10;
const MIN_SURNAME_IN_TEXT = 3;
// Main titles shorter than this ("Japan") only match with a matching author.
const MIN_TITLE_LENGTH = 4;
const ACCESS_ORDER = { open: 0, borrow: 1, 'print-disabled': 2 };

/** The words to search the Archive's titles for: the main title's, minus common ones. */
export function searchWords(title) {
  const main = withoutNotes(title).split(/\s*[:;]\s*|\s+[-–—/]+\s+/)[0];
  const words = main
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    // Single letters ("l" of "l’État") may not be words in the Archive's index.
    .filter((word) => (word.length > 1 || /\d/.test(word)) && !STOPWORDS.has(word));
  return [...new Set(words)].slice(0, MAX_SEARCH_WORDS);
}

/**
 * The words to search the Archive for, in any field, for a citation printed as text: the
 * first few of 3+ letters that aren't common words or citation apparatus. They're all
 * required, so a note citing several works finds nothing, by design.
 */
export function printedSearchWords(text) {
  const words = (text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word) && !CITATION_WORDS.has(word));
  return [...new Set(words)].slice(0, MAX_SEARCH_WORDS);
}

/** Best first: open before borrowable before print-disabled-only, then closest in year. */
function bestFirst(items, year) {
  const distance = (item) =>
    year == null || item.year == null ? Infinity : Math.abs(item.year - year);
  return items.sort(
    (a, b) => ACCESS_ORDER[a.access] - ACCESS_ORDER[b.access] || distance(a) - distance(b),
  );
}

/**
 * The items a citation printed as text refers to, best first: each item's main title appears
 * in the text, and so does one of its creators' surnames. Items without creators can't be
 * checked, so they don't match.
 *
 * @param {string} text
 * @param {number | null} year  The year read from the citation, for ordering.
 * @param {ArchiveItem[]} items
 * @returns {ArchiveItem[]}
 */
export function matchArchiveItemsInText(text, year, items) {
  const printed = squash(text);
  const matches = items.filter((item) => {
    const main = mainTitle(item.title);
    if (main.length < MIN_TITLE_IN_TEXT || !printed.includes(main)) return false;
    return item.creators.some((creator) => {
      const name = surname(creator);
      return name.length >= MIN_SURNAME_IN_TEXT && printed.includes(name);
    });
  });
  return bestFirst(matches, year);
}

/**
 * The items that are `work`, best first: open before borrowable before print-disabled-only,
 * then closest in year.
 *
 * @param {{ title: string | null, authors: { name: string }[], year: number | null }} work
 * @param {ArchiveItem[]} items
 * @returns {ArchiveItem[]}
 */
export function matchArchiveItems(work, items) {
  const main = mainTitle(work.title);
  if (!main) return [];
  const full = fullTitle(work.title);
  const author = surname(work.authors?.[0]?.name);
  const matches = items.filter((item) => {
    if (mainTitle(item.title) !== main && fullTitle(item.title) !== full) return false;
    const creators = squash(item.creators.join(' '));
    if (author && creators) return creators.includes(author);
    // Either side has no author: only trust the whole title, and only a long one.
    return fullTitle(item.title) === full && main.length >= MIN_TITLE_LENGTH && full.length >= 20;
  });
  return bestFirst(matches, work.year);
}

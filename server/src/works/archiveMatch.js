// Matching a work to Internet Archive items. The Archive has no DOIs for most books, so this
// goes by title and author: the main title (before any subtitle) must be the same, and the
// first author's surname must be among the item's creators. Different editions of a book are
// all matches.

/** @typedef {import('../providers/internetarchive.js').ArchiveItem} ArchiveItem */

// Words too common to search on. Matching still compares whole titles.
const STOPWORDS = new Set(
  'a an and the of in on to for or not der die das und von la le les de des et il el y'.split(' '),
);
const MAX_SEARCH_WORDS = 8;
// Main titles shorter than this ("Japan") only match with a matching author.
const MIN_TITLE_LENGTH = 4;
const ACCESS_ORDER = { open: 0, borrow: 1, 'print-disabled': 2 };

/** Lowercase letters and digits only, accents removed, "&" read as "and". */
const squash = (text) =>
  (text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** A title without parenthetical notes ("(Pelican books, A1000)"). */
const withoutNotes = (title) => (title ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');

/**
 * The title before any subtitle or statement of responsibility, squashed, without a leading
 * article. Catalogs separate subtitles with ":", " - ", ";" or " / ".
 */
export function mainTitle(title) {
  const main = withoutNotes(title).split(/\s*[:;]\s*|\s+[-–—/]+\s+|\.\s+-+/)[0];
  return squash(main.replace(/^\s*(the|a|an)\s+/i, ''));
}

const fullTitle = (title) => squash(withoutNotes(title).replace(/^\s*(the|a|an)\s+/i, ''));

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

/** "E. P. Thompson" → "thompson". Names written "Surname, Given" give the part before the comma. */
function surname(name) {
  const text = (name ?? '').trim();
  const part = text.includes(',') ? text.split(',')[0] : text.split(/\s+/).at(-1);
  return squash(part);
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
  const distance = (item) =>
    work.year == null || item.year == null ? Infinity : Math.abs(item.year - work.year);
  return matches.sort(
    (a, b) => ACCESS_ORDER[a.access] - ACCESS_ORDER[b.access] || distance(a) - distance(b),
  );
}

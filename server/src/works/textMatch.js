// Comparing titles and names across catalogs, which format them differently: punctuation,
// accents, "&" for "and", subtitles, and notes in parentheses.

/** Lowercase letters and digits only, accents removed, "&" read as "and". */
export const squash = (text) =>
  (text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** A title without parenthetical notes ("(Pelican books, A1000)"). */
export const withoutNotes = (title) => (title ?? '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');

/**
 * The title before any subtitle or statement of responsibility, squashed, without a leading
 * article. Catalogs separate subtitles with ":", " - ", ";" or " / ".
 */
export function mainTitle(title) {
  const main = withoutNotes(title).split(/\s*[:;]\s*|\s+[-–—/]+\s+|\.\s+-+/)[0];
  return squash(main.replace(/^\s*(the|a|an)\s+/i, ''));
}

/** The whole title, squashed, without notes or a leading article. */
export const fullTitle = (title) => squash(withoutNotes(title).replace(/^\s*(the|a|an)\s+/i, ''));

/**
 * A person's surname, squashed: "E. P. Thompson" → "thompson", "Thompson, E. P." → "thompson".
 * Reference lists also write "Fox E.W.", so initials after a name are skipped.
 */
export function surname(name) {
  const text = (name ?? '').trim();
  if (text.includes(',')) return squash(text.split(',')[0]);
  const words = text.split(/\s+/).filter((word) => !/^(\p{Lu}\.?-?)+$/u.test(word));
  return squash(words.at(-1) ?? text);
}

// Works' languages and scripts, for the language filter and the details panel. Pure, with no
// UI dependencies, so graph logic can filter by language.

/** The filter key of a work with no known language. */
export const UNKNOWN_LANGUAGE = 'unknown';

/** A work's language filter key: its ISO 639 code, or UNKNOWN_LANGUAGE. */
export const languageKey = (work) => work?.language || UNKNOWN_LANGUAGE;

let displayNames = null;

/** A language's English name ("fr" → "French"), or the code itself if it has none. */
export function languageName(key) {
  if (key === UNKNOWN_LANGUAGE) return 'Unknown language';
  try {
    displayNames ??= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = displayNames.of(key);
    return name && name !== key ? name : key.toUpperCase();
  } catch {
    return key.toUpperCase();
  }
}

// Names of the scripts the server tells apart (scriptOf in server/src/works/titles.js).
const SCRIPT_LABELS = {
  latin: 'Latin script',
  han: 'Chinese characters',
  japanese: 'Japanese script',
  hangul: 'Hangul',
  cyrillic: 'Cyrillic',
  greek: 'Greek',
  arabic: 'Arabic script',
  hebrew: 'Hebrew',
  devanagari: 'Devanagari',
  thai: 'Thai',
};

export const scriptLabel = (script) => SCRIPT_LABELS[script] ?? null;

/**
 * A `lang` attribute for text in `script`, so browsers pick the right glyphs (Chinese,
 * Japanese and Korean share characters drawn differently), or undefined when it doesn't
 * matter or can't be told.
 *
 * @param {string | null} script
 * @param {string | null} language  The work's language, if known.
 */
export function langFor(script, language) {
  if (script === 'japanese') return 'ja';
  if (script === 'hangul') return 'ko';
  if (script === 'han') return ['zh', 'ja', 'ko'].includes(language) ? language : 'zh';
  return undefined;
}

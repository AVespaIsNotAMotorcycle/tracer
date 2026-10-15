// A work's other titles: the original title of a translation, or the same title in another
// script (a Chinese or Russian title next to its romanization), as a provider deposited them;
// and its language, checked against its title's script.

import { fullTitle } from './textMatch.js';

// Scripts told apart, by the Unicode script of their letters. Japanese mixes kanji (Han) with
// kana, so any kana makes a title Japanese.
const SCRIPTS = [
  ['han', /\p{Script=Han}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
  ['thai', /\p{Script=Thai}/u],
  ['latin', /\p{Script=Latin}/u],
];

/**
 * The script most of a text's letters are in: 'latin', 'han' (Chinese characters),
 * 'japanese', 'hangul', 'cyrillic', 'greek', 'arabic', 'hebrew', 'devanagari', 'thai', or
 * 'other'. Null for text without letters.
 *
 * @param {string | null | undefined} text
 */
export function scriptOf(text) {
  const counts = new Map();
  let letters = 0;
  for (const char of text ?? '') {
    if (!/\p{L}/u.test(char)) continue;
    letters++;
    const found = SCRIPTS.find(([, pattern]) => pattern.test(char));
    const script = found ? found[0] : 'other';
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  if (letters === 0) return null;
  if (counts.has('kana')) return 'japanese';
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * @typedef {object} OtherTitle
 * @property {string} title
 * @property {'original' | 'alternate'} kind  The deposited original title (of a translation,
 *   or in the original script), or the deposited title where it's in another script than
 *   the one shown.
 * @property {string | null} script  See scriptOf.
 */

/**
 * The titles of a work other than `title` (the one shown) worth showing beside it: the
 * deposited original title, unless it's the same, and the deposited title when it's in a
 * different script (a romanized title next to the original, or the reverse). Titles that
 * differ only in case, punctuation or a leading article aren't repeated.
 *
 * @param {string | null} title
 * @param {{ title?: string | null, originalTitle?: string | null } | null} deposited
 * @returns {OtherTitle[]}
 */
export function otherTitles(title, deposited) {
  const result = [];
  const seen = new Set([fullTitle(title)]);
  const add = (text, kind) => {
    const key = fullTitle(text);
    if (!text || !key || seen.has(key)) return;
    seen.add(key);
    result.push({ title: text, kind, script: scriptOf(text) });
  };
  add(deposited?.originalTitle, 'original');
  if (deposited?.title && scriptOf(deposited.title) !== scriptOf(title)) {
    add(deposited.title, 'alternate');
  }
  return result;
}

// Languages usually written in each script other than Latin, to check a language against a
// title (a title in Chinese characters isn't in English).
const SCRIPT_LANGUAGES = {
  han: ['zh', 'ja'],
  japanese: ['ja'],
  hangul: ['ko'],
  cyrillic: ['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'mn', 'tg'],
  greek: ['el'],
  arabic: ['ar', 'fa', 'ur', 'ps', 'ku'],
  hebrew: ['he', 'yi'],
  devanagari: ['hi', 'mr', 'ne', 'sa'],
  thai: ['th'],
};
const NON_LATIN = new Set(Object.values(SCRIPT_LANGUAGES).flat());

/** Whether `language` is plausibly the language of a title in `script`. */
function fitsScript(language, script) {
  if (!script || script === 'other') return true;
  if (script === 'latin') return !NON_LATIN.has(language) || language === 'sr';
  return SCRIPT_LANGUAGES[script]?.includes(language) ?? true;
}

/**
 * A work's language from what OpenAlex detected (from its title and abstract) and what the
 * publisher deposited with Crossref. Deposits are often a journal's default rather than the
 * article's: the Chinese Science Bulletin deposits "en" for articles with Chinese titles. So
 * OpenAlex's is used unless it has none, or the two disagree and only the deposited one fits
 * the title's script.
 *
 * @param {string | null} title
 * @param {string | null} detected  OpenAlex's.
 * @param {string | null} deposited  Crossref's.
 * @returns {{ language: string | null, from: 'detected' | 'deposited' | null }}
 */
export function chooseLanguage(title, detected, deposited) {
  if (!detected && !deposited) return { language: null, from: null };
  if (!deposited || deposited === detected) return { language: detected, from: 'detected' };
  if (!detected) return { language: deposited, from: 'deposited' };
  const script = scriptOf(title);
  return fitsScript(deposited, script) && !fitsScript(detected, script)
    ? { language: deposited, from: 'deposited' }
    : { language: detected, from: 'detected' };
}

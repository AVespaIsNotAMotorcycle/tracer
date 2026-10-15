// Matching a work's authors to people on Wikidata, and the names worth showing beside the one
// a provider gives: a romanized "Masao Maruyama" next to 丸山眞男, or the reverse.
//
// Matching is conservative, since showing someone else's name is worse than showing none.
// People come from the work's own Wikidata item (its credited authors) or from an author's
// ORCID iD; there's no search by name, which can't tell apart the four Japanese people named
// Masao Maruyama. A credited author must also agree on the name.

import { squash, surname } from './textMatch.js';
import { scriptOf } from './titles.js';

/** @typedef {import('../providers/wikidata.js').WikidataCredit} WikidataCredit */
/** @typedef {import('../providers/wikidata.js').WikidataPerson} WikidataPerson */

/**
 * @typedef {object} OtherName
 * @property {string} text
 * @property {string | null} language  Its language tag, for a `lang` attribute.
 * @property {string | null} reading  For a Japanese name, how it's read, in kana.
 * @property {'native' | 'romanized'} kind  The name in its own script, or a romanization of it.
 */

// What a label in each language must look like to be taken for a native name. A Japanese name
// has kanji: one in katakana alone (エドワード・P・トムスン) is a foreign name transliterated.
const NATIVE_FORMS = {
  ja: (text) => /\p{Script=Han}/u.test(text),
  zh: (text) => scriptOf(text) === 'han',
  ko: (text) => scriptOf(text) === 'hangul',
  ru: (text) => scriptOf(text) === 'cyrillic',
  uk: (text) => scriptOf(text) === 'cyrillic',
};

// Most other names shown per author.
const MAX_OTHER_NAMES = 2;

/** The words of a Latin-script name (initials dropped), squashed. */
const nameWords = (name) =>
  new Set(
    (name ?? '')
      .split(/[\s,]+/)
      .map(squash)
      .filter((word) => word.length > 1),
  );

/**
 * Whether two names are the same person's: for Latin script, the surname of one is a word of
 * the other (so "Maruyama Masao", family name first, matches "Masao Maruyama"); otherwise the
 * same characters, in any order and spacing ("春凤 杨" and "杨春凤").
 */
export function sameName(a, b) {
  if (!a || !b) return false;
  const [scriptA, scriptB] = [scriptOf(a), scriptOf(b)];
  if (scriptA !== scriptB) return false;
  if (scriptA === 'latin') {
    const [first, second] = [surname(a), surname(b)];
    return Boolean(first && second) && (nameWords(b).has(first) || nameWords(a).has(second));
  }
  const chars = (text) => [...squash(text)].sort().join('');
  return chars(a) === chars(b);
}

/** Every name Wikidata gives a person, and the one a credit printed. */
const namesOf = (person, credit) => [
  ...(credit?.statedAs ? [credit.statedAs] : []),
  ...Object.values(person.labels),
  ...person.aliases,
  ...person.nativeNames.map((native) => native.text),
];

/**
 * The person on Wikidata each of a work's authors is, by their index in `authors`. An author
 * matches a person with the same ORCID iD; otherwise a credited author (from the work's item)
 * whose name agrees, the one at the same place in the author list first. Each person matches
 * one author at most.
 *
 * @param {{ name: string, orcid?: string | null }[]} authors  The work's, from its provider.
 * @param {WikidataCredit[]} credits  The work's item's authors, in order.
 * @param {WikidataPerson[]} people  Everyone credited, and anyone found by ORCID.
 * @returns {Map<number, WikidataPerson>}
 */
export function matchAuthors(authors, credits, people) {
  const byId = new Map(people.map((person) => [person.id, person]));
  const used = new Set();
  const matches = new Map();
  const take = (index, person) => {
    matches.set(index, person);
    used.add(person.id);
  };
  authors.forEach((author, index) => {
    const person = author.orcid && people.find((p) => p.orcid === author.orcid);
    if (person && !used.has(person.id)) take(index, person);
  });
  authors.forEach((author, index) => {
    if (matches.has(index)) return;
    const agrees = (credit) => {
      const person = byId.get(credit.id);
      return (
        person &&
        !used.has(person.id) &&
        namesOf(person, credit).some((name) => sameName(author.name, name))
      );
    };
    const credit =
      credits.find((c) => c.ordinal === index + 1 && agrees(c)) ?? credits.find(agrees);
    if (credit) take(index, byId.get(credit.id));
  });
  return matches;
}

/**
 * Names of `person` worth showing beside `name` (as the provider gives it): their name in their
 * own script (their native name, or failing that their label in the language they wrote in,
 * or in their country's, if in that language's script)
 * when `name` is in another script, with its kana reading for a Japanese name; and when `name`
 * isn't in Latin script, a romanization (their English label). Thompson's native name is
 * English, so nothing is shown for him, though Wikidata has his name in Japanese and Russian:
 * those are transliterations, not his name.
 *
 * @param {string} name
 * @param {WikidataPerson} person
 * @returns {OtherName[]}
 */
export function otherNames(name, person) {
  const script = scriptOf(name);
  const result = [];
  const seen = new Set([squash(name)]);
  const add = (text, language, kind) => {
    const key = squash(text);
    if (!text || !key || seen.has(key) || scriptOf(text) === script || !scriptOf(text)) return;
    seen.add(key);
    const japanese = language?.startsWith('ja');
    result.push({
      text,
      language: language ?? null,
      reading: japanese ? (person.kanaReadings[0] ?? null) : null,
      kind,
    });
  };
  // Their native name; failing that, their label in a language they wrote in; failing that,
  // in their country's language. A label only counts in a script that language uses.
  const labelsIn = (languages) =>
    languages
      .map((language) => ({ text: person.labels[language], language }))
      .filter(({ text, language }) => text && (NATIVE_FORMS[language]?.(text) ?? true));
  const natives = person.nativeNames.length
    ? person.nativeNames
    : ([labelsIn(person.languages), labelsIn(person.countryLanguages ?? [])].find(
        (list) => list.length,
      ) ?? []);
  for (const native of natives) add(native.text, native.language, 'native');
  if (script !== 'latin') {
    add(person.labels.en ?? person.labels.mul, 'en', 'romanized');
  }
  return result.slice(0, MAX_OTHER_NAMES);
}

/** Links to a person's Wikidata item, and their VIAF record if they have one. */
export function personLinks(person) {
  const links = [{ kind: 'wikidata', url: `https://www.wikidata.org/wiki/${person.id}` }];
  if (person.viaf) links.push({ kind: 'viaf', url: `https://viaf.org/viaf/${person.viaf}` });
  return links;
}

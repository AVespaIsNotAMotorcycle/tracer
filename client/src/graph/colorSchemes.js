// How the graph colors its works: by relation to the anchor (citing or cited), by which
// anchors a work is near (see anchorNeighborhoods), or by academic field (OpenAlex's primary
// topic, at a chosen level). Pure, with no UI dependencies.

export const COLOR_SCHEMES = [
  { value: 'relation', label: 'Relation to anchor' },
  { value: 'neighborhood', label: 'Anchor neighborhood' },
  { value: 'field', label: 'Academic field' },
];

// Levels of OpenAlex's topic hierarchy to color by. Fields are too coarse for most of
// Tracer's graphs (80 of the 88 works around Manchus and Han are "Social Sciences"), topics
// too fine for some (Thompson's 51 works have 40), so subfields are the default.
export const FIELD_LEVELS = [
  { value: 'field', label: 'Field', plural: 'fields' },
  { value: 'subfield', label: 'Subfield', plural: 'subfields' },
  { value: 'topic', label: 'Topic', plural: 'topics' },
];
export const DEFAULT_FIELD_LEVEL = 'subfield';

// Fields with a color of their own (--node-field-1 … 3); the rest are "Other". Any two fields
// can be neighbors on the graph, and only three categorical colors stay distinguishable in
// every pair, for every kind of color vision, in both themes (checked with the dataviz palette
// validator, --pairs all); past three, the guidance is to fold the rest into Other.
export const FIELD_COLORS = 3;

/** The scheme a graph uses until the user picks one: by anchor with several, else relation. */
export const defaultColorScheme = (anchorCount) => (anchorCount > 1 ? 'neighborhood' : 'relation');

/**
 * A work's category at `level` ('field', 'subfield' or 'topic'), from its primary topic:
 * { key, name }, or null when OpenAlex gives it none.
 */
export function fieldOf(work, level) {
  const topic = work?.topic;
  if (!topic) return null;
  const entry = level === 'topic' ? topic : topic[level];
  return entry?.id && entry.name ? { key: entry.id, name: entry.name } : null;
}

/**
 * How many works fall in each category at `level`.
 *
 * @param {Iterable<object>} works
 * @returns {Map<string, { name: string, count: number }>}
 */
export function fieldCounts(works, level) {
  const counts = new Map();
  for (const work of works) {
    const field = fieldOf(work, level);
    if (!field) continue;
    const entry = counts.get(field.key) ?? { name: field.name, count: 0 };
    entry.count++;
    counts.set(field.key, entry);
  }
  return counts;
}

/**
 * Which color (0 to `slots` - 1) each of the most common categories gets. A category keeps
 * the color it had (`previous`) for as long as it stays among the most common, so expanding a
 * work doesn't repaint the others; the rest of the most common take the free colors, most
 * common first (ties by name).
 *
 * @param {Map<string, number>} previous
 * @param {Map<string, { name: string, count: number }>} counts
 * @returns {Map<string, number>}
 */
export function assignFieldColors(previous, counts, slots = FIELD_COLORS) {
  const top = [...counts]
    .sort((a, b) => b[1].count - a[1].count || a[1].name.localeCompare(b[1].name))
    .slice(0, slots)
    .map(([key]) => key);
  const next = new Map();
  for (const key of top) if (previous.has(key)) next.set(key, previous.get(key));
  const taken = new Set(next.values());
  const free = Array.from({ length: slots }, (_, i) => i).filter((slot) => !taken.has(slot));
  for (const key of top) if (!next.has(key)) next.set(key, free.shift());
  return next;
}

/**
 * Each work's color under the field scheme: its category's color (0 to FIELD_COLORS - 1),
 * 'other' for a less common category, or null for a work with no topic.
 *
 * @param {Iterable<object>} works
 * @param {string} level
 * @param {Map<string, number>} colors  From assignFieldColors.
 * @returns {Map<string, number | 'other' | null>}
 */
export function workFieldColors(works, level, colors) {
  const result = new Map();
  for (const work of works) {
    const field = fieldOf(work, level);
    result.set(work.id, field ? (colors.get(field.key) ?? 'other') : null);
  }
  return result;
}

// Reading statuses a work can have in the user's library (see server/src/models/LibraryEntry.js),
// in reading order. Pure, with no UI dependencies; the icons are in ReadingStatusIcon.jsx and
// GraphView.jsx.

export const READING_STATUSES = [
  { value: 'to-read', label: 'To read' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
  { value: 'cited', label: 'Cited' },
];

export const statusLabel = (status) =>
  READING_STATUSES.find((entry) => entry.value === status)?.label ?? null;

/**
 * A work's status: its own, or failing that one recorded under a work merged into it (see
 * mergedIds), so a status set before a merge still shows.
 *
 * @param {Map<string, string>} statuses
 * @param {{ id: string, mergedIds?: string[] }} work
 */
export function statusOf(statuses, work) {
  if (!work) return null;
  if (statuses.has(work.id)) return statuses.get(work.id);
  for (const id of work.mergedIds ?? []) if (statuses.has(id)) return statuses.get(id);
  return null;
}

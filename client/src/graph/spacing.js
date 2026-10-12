// How far apart the layout spaces works, by graph size. Pure, so it's testable without canvas.

// Graphs up to this many works keep the base spacing.
const BASE_WORKS = 60;
// The factor moves in steps of this size, so a small expansion doesn't shift every work.
const STEP = 0.25;

/**
 * Factor to scale layout distances by for a graph of `count` works. Laying out N works at the
 * same density needs an area proportional to N, so distances grow with √N: about 2.5 for 400
 * works. 1 up to BASE_WORKS works; rounded to the nearest STEP.
 *
 * @param {number} count
 */
export function layoutSpread(count) {
  const exact = Math.sqrt(Math.max(count, BASE_WORKS) / BASE_WORKS);
  return Math.max(1, Math.round(exact / STEP) * STEP);
}

// Shaping a work's citations per year for its chart (see CitationsByYear.jsx).

/** Every year from the first to the last, with 0 for the years nothing cited it. */
export function fillYears(years) {
  if (years.length === 0) return [];
  const counts = new Map(years.map(({ year, count }) => [year, count]));
  const first = years[0].year;
  const last = years.at(-1).year;
  return Array.from({ length: last - first + 1 }, (_, i) => ({
    year: first + i,
    count: counts.get(first + i) ?? 0,
  }));
}

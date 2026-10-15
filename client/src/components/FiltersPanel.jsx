import { Minus, Plus } from 'lucide-react';
import { NO_FILTERS } from '../graph/graphModel.js';
import { languageKey, languageName, UNKNOWN_LANGUAGE } from '../graph/languages.js';
import { sourceType } from '../graph/sourceTypes.js';

const parseYear = (value) => (value === '' ? null : Number(value));

/** Source types on the graph with their counts, most common first. */
function typeCounts(works) {
  const counts = new Map();
  for (const work of works.values()) {
    const { key } = sourceType(work.type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Languages on the graph with their counts, most common first, unknown last. */
function languageCounts(works) {
  const counts = new Map();
  for (const work of works.values()) {
    const key = languageKey(work);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const unknownLast = (key) => (key === UNKNOWN_LANGUAGE ? 1 : 0);
  return [...counts].sort(
    (a, b) =>
      unknownLast(a[0]) - unknownLast(b[0]) ||
      b[1] - a[1] ||
      languageName(a[0]).localeCompare(languageName(b[0])),
  );
}

/**
 * Filters hide works from the view; they never remove works from the graph. The source-type
 * list doubles as the legend for the node icons.
 */
export default function FiltersPanel({
  filters,
  onChange,
  works,
  maxConnections,
  visibleCount,
  totalCount,
  pinnedCount = 0,
}) {
  const excluded = new Set(filters.excludedTypes);
  // The slider shows a minimum above the graph's maximum (after works are removed) as the
  // maximum, so stepping starts from what it shows.
  const minConnections = Math.min(filters.minConnections, maxConnections);
  const setMinConnections = (value) =>
    onChange({ ...filters, minConnections: Math.max(1, Math.min(maxConnections, value)) });
  const toggle = (field, key) => {
    const next = new Set(filters[field] ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...filters, [field]: [...next] });
  };
  const excludedLanguages = new Set(filters.excludedLanguages ?? []);

  return (
    <section className="panel" aria-labelledby="filters-heading">
      <h2 id="filters-heading">Filters</h2>
      <div className="filter-row">
        <label>
          From year
          <input
            type="number"
            value={filters.minYear ?? ''}
            onChange={(event) => onChange({ ...filters, minYear: parseYear(event.target.value) })}
          />
        </label>
        <label>
          To year
          <input
            type="number"
            value={filters.maxYear ?? ''}
            onChange={(event) => onChange({ ...filters, maxYear: parseYear(event.target.value) })}
          />
        </label>
      </div>
      <div className="filter-range">
        <span id="min-connections-label">
          Cited by or cites at least {filters.minConnections} on graph
        </span>
        <div className="stepper">
          <button
            type="button"
            onClick={() => setMinConnections(minConnections - 1)}
            disabled={minConnections <= 1}
            aria-label="Decrease minimum links"
          >
            <Minus className="icon" aria-hidden="true" />
          </button>
          <input
            type="range"
            min={1}
            max={maxConnections}
            value={filters.minConnections}
            onChange={(event) => setMinConnections(Number(event.target.value))}
            aria-labelledby="min-connections-label"
          />
          <button
            type="button"
            onClick={() => setMinConnections(minConnections + 1)}
            disabled={minConnections >= maxConnections}
            aria-label="Increase minimum links"
          >
            <Plus className="icon" aria-hidden="true" />
          </button>
        </div>
      </div>
      <fieldset className="type-filter">
        <legend>Source types</legend>
        <ul className="source-types">
          {typeCounts(works).map(([key, count]) => {
            const { label, Icon } = sourceType(key);
            return (
              <li key={key}>
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.has(key)}
                    onChange={() => toggle('excludedTypes', key)}
                  />
                  <Icon className="icon" aria-hidden="true" />
                  <span>{label}</span>
                  <span className="muted">{count}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <fieldset className="type-filter">
        <legend>Languages</legend>
        <ul className="source-types languages">
          {languageCounts(works).map(([key, count]) => (
            <li key={key}>
              <label>
                <input
                  type="checkbox"
                  checked={!excludedLanguages.has(key)}
                  onChange={() => toggle('excludedLanguages', key)}
                />
                <span>{languageName(key)}</span>
                <span className="muted">{count}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="filter-footer">
        <span className="muted">
          Showing {visibleCount} of {totalCount}
          {pinnedCount > 0 && ` · ${pinnedCount} pinned`}
        </span>
        <button
          type="button"
          className="link-button"
          onClick={() => onChange(NO_FILTERS)}
          aria-label="Reset filters"
        >
          Reset
        </button>
      </div>
    </section>
  );
}

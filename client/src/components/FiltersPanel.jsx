import { NO_FILTERS } from '../graph/graphModel.js';
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
}) {
  const excluded = new Set(filters.excludedTypes);
  const toggleType = (key) => {
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange({ ...filters, excludedTypes: [...next] });
  };

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
      <label className="filter-range">
        Cited by or cites at least {filters.minConnections} on graph
        <input
          type="range"
          min={1}
          max={maxConnections}
          value={filters.minConnections}
          onChange={(event) => onChange({ ...filters, minConnections: Number(event.target.value) })}
        />
      </label>
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
                    onChange={() => toggleType(key)}
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
      <div className="filter-footer">
        <span className="muted">
          Showing {visibleCount} of {totalCount}
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

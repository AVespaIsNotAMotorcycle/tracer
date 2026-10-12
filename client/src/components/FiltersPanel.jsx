import { NO_FILTERS } from '../graph/graphModel.js';

const parseYear = (value) => (value === '' ? null : Number(value));

/** Filters hide works from the view; they never remove works from the graph. */
export default function FiltersPanel({ filters, onChange, maxCount, visibleCount, totalCount }) {
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
        Cited by at least {filters.minCitations} on graph
        <input
          type="range"
          min={0}
          max={Math.max(maxCount, 1)}
          value={filters.minCitations}
          onChange={(event) => onChange({ ...filters, minCitations: Number(event.target.value) })}
        />
      </label>
      <div className="filter-footer">
        <span className="muted">
          Showing {visibleCount} of {totalCount}
        </span>
        <button type="button" className="link-button" onClick={() => onChange(NO_FILTERS)}>
          Reset
        </button>
      </div>
    </section>
  );
}

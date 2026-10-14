import { useState } from 'react';
import { looksLikeWorkId, searchWorks } from '../api.js';
import { ANONYMOUS, NOT_IN_PLAN } from '../auth/entitlements.js';
import { sourceType } from '../graph/sourceTypes.js';

const DEPTHS = [0, 1, 2, 3];

/**
 * Finds an anchor work (by search, or directly by DOI / OpenAlex ID) and sets build options.
 * With `onApply`, the options can also be applied to the current graph; `canApply` says
 * whether they differ from the ones it was built with. The options go only as far as the
 * plan's `limits`, and with `advancedLocked` the plan doesn't include advanced search.
 */
export default function SearchPanel({
  options,
  onOptionsChange,
  onBuild,
  onApply,
  onAdvanced,
  canApply = false,
  advancedLocked = false,
  limits = ANONYMOUS.limits,
  busy,
  search = searchWorks,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  const setOption = (key) => (event) =>
    onOptionsChange({ ...options, [key]: Number(event.target.value) });

  const handleSubmit = async (event) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    if (looksLikeWorkId(value)) {
      setResults(null);
      onBuild(value);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      setResults(await search(value));
    } catch (err) {
      setError(err.message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="search-heading">
      <h2 id="search-heading">Start from a work</h2>
      <form onSubmit={handleSubmit} className="search-form">
        <label htmlFor="query" className="visually-hidden">
          Title, DOI, or OpenAlex ID
        </label>
        <input
          id="query"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Title, DOI, or OpenAlex ID"
          autoComplete="off"
        />
        <button type="submit" disabled={searching || !query.trim()}>
          {searching ? 'Searching…' : 'Go'}
        </button>
      </form>
      {onAdvanced && (
        <button
          type="button"
          className="link-button advanced-link"
          onClick={() => onAdvanced(looksLikeWorkId(query) ? '' : query.trim())}
          disabled={advancedLocked}
          title={advancedLocked ? NOT_IN_PLAN : undefined}
        >
          Advanced search
        </button>
      )}

      <fieldset className="options">
        <legend>Graph depth and size</legend>
        <label>
          Citing depth
          <select value={options.citingDepth} onChange={setOption('citingDepth')}>
            {DEPTHS.filter((d) => d <= limits.depth).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cited depth
          <select value={options.citedDepth} onChange={setOption('citedDepth')}>
            {DEPTHS.filter((d) => d <= limits.depth).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          Works per node
          <input
            type="number"
            min={1}
            max={limits.perNode}
            value={options.limit}
            onChange={setOption('limit')}
          />
        </label>
        <label>
          Max works
          <input
            type="number"
            min={10}
            max={limits.maxNodes}
            step={10}
            value={options.maxNodes}
            onChange={setOption('maxNodes')}
          />
        </label>
        {onApply && (
          <button
            type="button"
            className="apply-options"
            onClick={onApply}
            disabled={busy || !canApply}
          >
            Apply to current graph
          </button>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {results && (
        <div className="results-header">
          <span className="muted">
            {results.length === 0
              ? 'No works found.'
              : `${results.length} result${results.length === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={() => setResults(null)}
            aria-label="Close search results"
          >
            ×
          </button>
        </div>
      )}
      {results && results.length > 0 && (
        <ul className="results" aria-label="Search results">
          {results.map((work) => {
            const { label, Icon } = sourceType(work.type);
            return (
              <li key={work.id}>
                <button type="button" onClick={() => onBuild(work.id)} disabled={busy}>
                  <Icon className="icon result-icon" aria-hidden="true" />
                  <span className="visually-hidden">{`${label}: `}</span>
                  <span className="result-title">{work.title ?? 'Untitled'}</span>
                  <span className="muted">
                    {[work.authors[0]?.name, work.year, work.venue].filter(Boolean).join(' · ')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

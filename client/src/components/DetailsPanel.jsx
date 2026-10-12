const LINK_LABELS = {
  doi: 'DOI',
  landing_page: 'Publisher page',
  pdf: 'Open-access PDF',
  provider: 'OpenAlex',
};

const RELATION_LABELS = {
  root: 'Starting work',
  citing: 'Found as a citing work',
  cited: 'Found as a cited work',
};

/** Details for the selected work, with external links and an expand action. */
export default function DetailsPanel({
  work,
  relation,
  citedByOnGraph,
  citesOnGraph,
  expanded,
  expanding,
  onExpand,
  onClose,
}) {
  const fullyExpanded = expanded.has('citing') && expanded.has('cited');
  const byline = [work.year, work.venue, work.type].filter(Boolean).join(' · ');

  return (
    <aside className="details" aria-labelledby="details-title">
      <div className="details-header">
        <span className="muted">{RELATION_LABELS[relation]}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <h2 id="details-title">{work.title ?? 'Untitled'}</h2>
      {work.authors.length > 0 && (
        <p className="authors">{work.authors.map((author) => author.name).join(', ')}</p>
      )}
      {byline && <p className="muted">{byline}</p>}

      <dl className="stats">
        <div>
          <dt>Cited by on graph</dt>
          <dd>{citedByOnGraph}</dd>
        </div>
        <div>
          <dt>Cites on graph</dt>
          <dd>{citesOnGraph}</dd>
        </div>
        {work.citedByCount != null && (
          <div>
            <dt>Total citations</dt>
            <dd>{work.citedByCount.toLocaleString()}</dd>
          </div>
        )}
      </dl>

      <button
        type="button"
        className="primary"
        onClick={onExpand}
        disabled={expanding || fullyExpanded}
      >
        {expanding ? 'Expanding…' : fullyExpanded ? 'Expanded' : 'Expand citing and cited works'}
      </button>

      {work.links.length > 0 && (
        <>
          <h3>Links</h3>
          <ul className="links">
            {work.links.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {LINK_LABELS[link.kind] ?? link.kind}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}

      {work.abstract && (
        <>
          <h3>Abstract</h3>
          <p className="abstract">{work.abstract}</p>
        </>
      )}

      <p className="muted small">Data from {work.providers.join(', ')}</p>
    </aside>
  );
}

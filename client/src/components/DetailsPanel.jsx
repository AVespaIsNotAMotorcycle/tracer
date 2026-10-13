import { Minus, Pin, PinOff, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { getArchiveItems, getCitationMatch } from '../api.js';
import { canExpand } from '../graph/graphModel.js';
import { sourceType } from '../graph/sourceTypes.js';

const LINK_LABELS = {
  doi: 'DOI',
  jstor: 'JSTOR',
  landing_page: 'Publisher page',
  pdf: 'Open-access PDF',
  provider: 'OpenAlex',
};

// Who can read an Internet Archive copy.
const ARCHIVE_ACCESS = {
  open: 'free to read',
  borrow: 'borrow',
  'print-disabled': 'print-disabled access only',
};

/**
 * Something looked up about the selected work (`lookup(id, { signal })`; the server caches
 * it): `empty` until it arrives, and if the lookup fails, since it only adds links. Skipped
 * when `enabled` is false.
 */
function useWorkLookup(lookup, id, empty, enabled = true) {
  const [found, setFound] = useState({ id: null, value: empty });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    lookup(id, { signal: controller.signal })
      .then((value) => setFound({ id, value: value ?? empty }))
      .catch(() => {});
    return () => controller.abort();
  }, [lookup, id, empty, enabled]);
  return enabled && found.id === id ? found.value : empty;
}

const NO_ITEMS = [];

const RELATION_LABELS = {
  anchor: 'Anchor',
  citing: 'Found as a citing work',
  cited: 'Found as a cited work',
};

const authorsOf = (work) => work.authors.map((author) => author.name).join(', ');

/** The DOI link for a work, if it has one. */
const doiLink = (work) => work.links.find((link) => link.kind === 'doi');

/**
 * Details for the selected work, with external links and an expand action. A book lists its
 * `parts` (chapters folded into it on the graph; see foldBookParts), each as
 * `{ work, citedByOnGraph, citesOnGraph }`. A chapter's authors are shown only when they
 * differ from the book's. A work not on OpenAlex (known only from a reference list) can't be
 * expanded or made the anchor, so it shows its citation as printed instead. `yearInfo` (from
 * layoutYears) explains a listed year that was set aside as implausible. `onCollapse` is
 * given only for works the user expanded, and undoes that. `pinned` works are always shown,
 * whatever the filters; `onTogglePin` pins or unpins it. The anchor gets `onFindCoCitations`,
 * with `coCitationControl` ({ value, max, citers, onChange }) for the minimum number of works
 * citing it that must cite a work, and `coCitationResult` ({ minCiters, citers, found, left })
 * once it has run; a work co-cited with the anchor
 * has `coCitedBy`, how many works citing the anchor cite it. A work with no path of citations
 * on the graph to the anchor gets `pathControl` ({ disconnected, finding, result, onFind,
 * onSelect }) to look for the shortest one; `result` (see findPath in api.js) stays shown once
 * found, with each step selectable.
 */
const yearOf = (work) => (work.year == null ? '' : ` (${work.year})`);

/** Looking for, and showing, the shortest path of citations from a work to the anchor. */
function PathToAnchor({ disconnected, finding, result, onFind, onSelect }) {
  const path = result?.path;
  return (
    <div className="path-to-anchor">
      {path ? (
        <>
          <p className="small">
            Connected to the anchor in {path.length - 1} step{path.length === 2 ? '' : 's'}:
          </p>
          <ol className="path-steps" aria-label="Path to the anchor">
            {path.map(({ work, link }, index) => (
              <li key={work.id}>
                {link && (
                  <span className="muted small">
                    {link === 'cites' ? 'which cites ' : 'which is cited by '}
                  </span>
                )}
                {index === 0 ? (
                  <span>{work.title ?? 'Untitled'}</span>
                ) : (
                  <button type="button" className="link-button" onClick={() => onSelect(work.id)}>
                    {work.title ?? 'Untitled'}
                  </button>
                )}
                <span className="muted small">
                  {yearOf(work)}
                  {index === path.length - 1 ? ', the anchor' : ''}
                </span>
              </li>
            ))}
          </ol>
          {!result.complete && (
            <p className="muted small">
              Some much-cited works&rsquo; citing works were only partly searched, so a shorter path
              is possible.
            </p>
          )}
        </>
      ) : (
        disconnected && (
          <>
            <p className="muted small">
              No citations on the graph link this work to the anchor&rsquo;s.
            </p>
            <button type="button" onClick={onFind} disabled={finding}>
              {finding ? 'Finding a path…' : 'Find shortest path to the anchor'}
            </button>
            {result?.outcome === 'none' && (
              <p className="muted small">
                There&rsquo;s no path on OpenAlex: none of the {result.searched.toLocaleString()}{' '}
                works linked to this one, however distantly, reaches the anchor.
              </p>
            )}
            {result?.outcome === 'budget' && (
              <p className="muted small">
                No path found before the search reached its limit (
                {result.searched.toLocaleString()} works searched). Any path is long.
              </p>
            )}
          </>
        )
      )}
    </div>
  );
}

export default function DetailsPanel({
  work,
  relation,
  citedByOnGraph,
  citesOnGraph,
  yearInfo,
  parts = [],
  expanded,
  expanding,
  busy = false,
  onExpand,
  onMakeAnchor,
  onCollapse,
  pinned = false,
  onTogglePin,
  coCitedBy = null,
  onFindCoCitations,
  coCitationControl = null,
  findingCoCitations = false,
  coCitationResult = null,
  pathControl = null,
  onClose,
  inert = false,
}) {
  const fullyExpanded = expanded.has('citing') && expanded.has('cited');
  // A listed year set aside as implausible (see layoutYears) shows as a bound instead.
  const implausible = yearInfo?.listedYear != null;
  const year = implausible ? `Before ${yearInfo.citedFrom}` : (work.year ?? 'Year unknown');
  const byline = [year, work.venue].filter(Boolean).join(' · ');
  const { label: typeLabel, Icon: TypeIcon } = sourceType(work.type);
  const expandable = canExpand(work);
  // Copies on the Internet Archive; for a work not on OpenAlex, also the work Crossref
  // matched its citation to.
  const archiveItems = useWorkLookup(getArchiveItems, work.id, NO_ITEMS);
  const match = useWorkLookup(getCitationMatch, work.id, null, !expandable && !work.links.length);
  const links = [...work.links, ...(match?.links ?? [])];
  // Known only from a citation printed as text, which is shown as its title.
  const printedOnly = !expandable && Boolean(work.citation) && work.title === work.citation;

  return (
    <aside className="details" aria-labelledby="details-title" inert={inert}>
      <div className="details-header">
        <span className="muted">{RELATION_LABELS[relation]}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </div>
      <h2 id="details-title">{work.title ?? 'Untitled'}</h2>
      {work.authors.length > 0 && <p className="authors">{authorsOf(work)}</p>}
      <p className="muted with-icon">
        <TypeIcon className="icon" aria-hidden="true" />
        <span>
          {typeLabel} · {byline}
        </span>
      </p>
      {implausible && (
        <p className="muted small">
          OpenAlex gives {yearInfo.listedYear}, but works on this graph cite it from{' '}
          {yearInfo.citedFrom} on, so that&rsquo;s probably the year of a reprint or digitized copy.
        </p>
      )}
      {!expandable && (
        <>
          <p className="muted small">
            Known only from a reference list deposited with Crossref, so there are no citing or
            cited works to fetch.
          </p>
          {work.citation && work.citation !== work.title && (
            <blockquote className="citation">{work.citation}</blockquote>
          )}
          {match && (
            <p className="muted small">
              Crossref matches it to &ldquo;{match.title}&rdquo;
              {[match.venue, match.year].filter(Boolean).length > 0 &&
                ` (${[match.venue, match.year].filter(Boolean).join(', ')})`}
              , linked below.
            </p>
          )}
        </>
      )}

      <dl className="stats">
        <div>
          <dt>Cited by on graph</dt>
          <dd>{citedByOnGraph}</dd>
        </div>
        {expandable && (
          <div>
            <dt>Cites on graph</dt>
            <dd>{citesOnGraph}</dd>
          </div>
        )}
        {work.citedByCount != null && (
          <div>
            <dt>Total citations</dt>
            <dd>{work.citedByCount.toLocaleString()}</dd>
          </div>
        )}
      </dl>
      {parts.length > 0 && <p className="muted small">On-graph counts include its chapters.</p>}

      {expandable && (
        <button
          type="button"
          className="primary"
          onClick={onExpand}
          disabled={busy || expanding || fullyExpanded}
        >
          {expanding ? 'Expanding…' : fullyExpanded ? 'Expanded' : 'Expand citing and cited works'}
        </button>
      )}
      {onCollapse && (
        <button type="button" onClick={onCollapse} disabled={busy || expanding}>
          Collapse
        </button>
      )}
      {expandable && relation !== 'anchor' && (
        <button type="button" onClick={onMakeAnchor} disabled={busy}>
          Make this the anchor
        </button>
      )}

      {onFindCoCitations && coCitationControl && (
        <div className="co-citations">
          {coCitationControl.citers < 2 ? (
            <p className="muted small">
              Finding co-citations needs at least two works on the graph citing this one.
            </p>
          ) : (
            <div className="filter-range">
              <span id="co-citers-label">
                Cited by at least {coCitationControl.value} of the {coCitationControl.citers} works
                on the graph citing this one
              </span>
              <div className="stepper">
                <button
                  type="button"
                  onClick={() => coCitationControl.onChange(coCitationControl.value - 1)}
                  disabled={coCitationControl.value <= 2}
                  aria-label="Decrease minimum citing works"
                >
                  <Minus className="icon" aria-hidden="true" />
                </button>
                <input
                  type="range"
                  min={2}
                  max={coCitationControl.max}
                  value={coCitationControl.value}
                  onChange={(event) => coCitationControl.onChange(Number(event.target.value))}
                  aria-labelledby="co-citers-label"
                />
                <button
                  type="button"
                  onClick={() => coCitationControl.onChange(coCitationControl.value + 1)}
                  disabled={coCitationControl.value >= coCitationControl.max}
                  aria-label="Increase minimum citing works"
                >
                  <Plus className="icon" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={onFindCoCitations}
            disabled={busy || findingCoCitations || coCitationControl.citers < 2}
          >
            {findingCoCitations ? 'Finding co-citations…' : 'Find Co-Citations'}
          </button>
          {coCitationResult && (
            <p className="muted small">
              {coCitationResult.found === 0
                ? `No work is cited by ${coCitationResult.minCiters} or more of the ${coCitationResult.citers} works on the graph citing this one.`
                : `Found ${coCitationResult.found} ${coCitationResult.found === 1 ? 'work' : 'works'} cited by ${coCitationResult.minCiters} or more of the ${coCitationResult.citers} works on the graph citing this one, ringed on the graph.`}
              {coCitationResult.left > 0 &&
                ` ${coCitationResult.left} didn’t fit under the max works setting.`}
            </p>
          )}
        </div>
      )}
      {pathControl && <PathToAnchor {...pathControl} />}
      {coCitedBy != null && (
        <p className="muted small">
          Co-cited with the anchor: {coCitedBy} works on the graph citing the anchor cite this one
          too.
        </p>
      )}

      {onTogglePin && (
        <button type="button" className="with-icon" onClick={onTogglePin}>
          {pinned ? (
            <PinOff className="icon" aria-hidden="true" />
          ) : (
            <Pin className="icon" aria-hidden="true" />
          )}
          <span>{pinned ? 'Unpin' : 'Pin: always show'}</span>
        </button>
      )}

      {(links.length > 0 || archiveItems.length > 0) && (
        <>
          <h3>Links</h3>
          <ul className="links">
            {links.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {LINK_LABELS[link.kind] ?? link.kind}
                </a>
              </li>
            ))}
            {archiveItems.map((item) => (
              <li key={item.url}>
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  Internet Archive
                </a>{' '}
                {/* A printed citation may cite several works, so say which one this is. */}
                {printedOnly && <span>{item.title} </span>}
                <span className="muted small">
                  {[item.year, ARCHIVE_ACCESS[item.access]].filter(Boolean).join(' · ')}
                </span>
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

      {parts.length > 0 && (
        <>
          <h3>Chapters ({parts.length})</h3>
          <ul className="parts" aria-label="Chapters">
            {parts.map(({ work: part, citedByOnGraph: citedBy, citesOnGraph: cites }) => {
              const link = doiLink(part);
              const { key, label } = sourceType(part.type);
              return (
                <li key={part.id}>
                  <span className="part-title">
                    {link ? (
                      <a href={link.url} target="_blank" rel="noopener noreferrer">
                        {part.title ?? 'Untitled'}
                      </a>
                    ) : (
                      (part.title ?? 'Untitled')
                    )}
                  </span>
                  {authorsOf(part) !== authorsOf(work) && authorsOf(part) && (
                    <span className="muted">{authorsOf(part)}</span>
                  )}
                  <span className="muted small">
                    {[
                      key !== 'book-chapter' && label,
                      `Cited by ${citedBy} on graph`,
                      `cites ${cites}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}

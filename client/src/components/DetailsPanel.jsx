import { Minus, Pin, PinOff, Plus, TriangleAlert } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { getArchiveItems, getAuthorNames, getCitationMatch, getCitationsByYear } from '../api.js';
import { NOT_IN_PLAN } from '../auth/entitlements.js';
import { canExpand } from '../graph/graphModel.js';
import { langFor, languageName, scriptLabel } from '../graph/languages.js';
import {
  groupByProviders,
  describeWarning,
  listProviders,
  providerLabel,
} from '../graph/provenance.js';
import { sourceType } from '../graph/sourceTypes.js';
import { READING_STATUSES } from '../library/readingStatus.js';
import ReadingStatusIcon from '../library/ReadingStatusIcon.jsx';
import AddCitation from './AddCitation.jsx';
import CitationsByYear from './CitationsByYear.jsx';
import WorkNote from './WorkNote.jsx';

const LINK_LABELS = {
  doi: 'DOI',
  jstor: 'JSTOR',
  landing_page: 'Publisher page',
  pdf: 'Open-access PDF',
  provider: 'OpenAlex',
  wikidata: 'Wikidata',
  viaf: 'VIAF',
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
 * whatever the filters; `onTogglePin` pins or unpins it. `note` is the user's note on it, and
 * `onNoteChange` sets it ('' deletes it). Each anchor gets `onFindCoCitations`,
 * with `coCitationControl` ({ value, max, citers, onChange, locked }) for the minimum number of works
 * citing it that must cite a work, and `coCitationResult` ({ minCiters, citers, found, left })
 * once it has run; a work co-cited with the anchor
 * has `coCitedBy`, how many works citing the anchor cite it. A work with no path of citations
 * on the graph to an anchor gets `pathControl` ({ targets, choice, onChoose, finding, result,
 * onFind, onSelect, locked }; see PathToAnchor) to look for the shortest one; `result` (see findPath in api.js) stays shown once
 * found, with each step selectable. `locked` means the plan doesn't include that search.
 *
 * With `anchorControl` ({ count, limit, onAdd, onRemove }), a work can be added as another
 * anchor (up to `limit`), and an anchor removed when there are several (`manyAnchors`). Then
 * `neighborhood` lists the anchors it's near ({ id, index, title }; see anchorNeighborhoods).
 *
 * When the work Crossref matches a reference-only work to is on OpenAlex, the server merges
 * them, and `onMerged` gets that work to put in its place.
 *
 * Signed in, `onAddCitation` records a citation the databases missed (see AddCitation), to one
 * of `graphWorks` or another work; `manualLinks` ({ link, other, direction }) are those the
 * user added, each removable with `onRemoveManualLink`, and a work the user added (`manual`)
 * can be deleted with `onDeleteManualWork`.
 *
 * `readingStatus` is its status in the user's library, set with `onReadingStatusChange` (absent
 * when signed out, or without the feature: `readingStatusUnavailable` says which).
 *
 * `referenceWarning` (see referenceWarning) says its references are probably missing.
 * `graphLinks` are its citations on the graph with where each came from (see graphLinks),
 * and `onSelectWork` selects one of the works they link to.
 */
/**
 * A work's original title, or its title in another script (see otherTitles on the server),
 * labeled with its script when that differs from the title shown.
 */
function OtherTitle({ other, work }) {
  const label = other.kind === 'original' ? 'Original title' : 'Also titled';
  const script = scriptLabel(other.script);
  return (
    <p className="other-title">
      <span className="muted small">
        {label}
        {script && ` (${script})`}
      </span>{' '}
      <span lang={langFor(other.script, work.language)}>{other.title}</span>
    </p>
  );
}

/** Where a group of links came from: "from OpenAlex only", "from both OpenAlex and Crossref". */
function groupSource(providers) {
  if (providers.length === 0) return 'source not recorded';
  if (providers.length === 1) return `from ${providerLabel(providers[0])} only`;
  return `from ${providers.length === 2 ? 'both ' : ''}${listProviders(providers)}`;
}

/**
 * How many links, and where they came from, each link counted once: "15: 13 from OpenAlex
 * only, 2 from both OpenAlex and Crossref", or when one group holds them all, "20, all from
 * OpenAlex" or "15, source not recorded".
 */
function providerSummary(links) {
  const groups = groupByProviders(links);
  const total = links.length;
  if (groups.length === 1) {
    const [{ providers }] = groups;
    if (providers.length === 0) return `${total}, source not recorded`;
    const both = providers.length === 2 ? 'both ' : '';
    return `${total}, ${total === 1 ? '' : 'all '}from ${both}${listProviders(providers)}`;
  }
  return `${total}: ${groups.map(({ providers, count }) => `${count} ${groupSource(providers)}`).join(', ')}`;
}

/**
 * Where a work's data comes from: its record's provider and the others that added citations,
 * how many of its links on the graph each provider has (`links`; see graphLinks), and the
 * links OpenAlex doesn't have, each selectable.
 */
/**
 * The work's authors, each with their name in other scripts where Wikidata has it (`names`;
 * see getAuthorNames): "Masao Maruyama (丸山眞男 · まるやま まさお)".
 */
function Authors({ authors, names }) {
  const byIndex = new Map(names.map((entry) => [entry.index, entry.otherNames]));
  return (
    <p className="authors">
      {authors.map((author, index) => {
        const others = byIndex.get(index) ?? [];
        return (
          <Fragment key={index}>
            {index > 0 && ', '}
            {author.name}
            {others.length > 0 && (
              <span className="other-names">
                {' ('}
                {others.map((other, i) => (
                  <Fragment key={other.text}>
                    {i > 0 && ', '}
                    <span lang={other.language ?? undefined}>{other.text}</span>
                    {other.reading && (
                      <span className="muted" lang="ja">
                        {' · '}
                        {other.reading}
                      </span>
                    )}
                  </Fragment>
                ))}
                {')'}
              </span>
            )}
          </Fragment>
        );
      })}
    </p>
  );
}

/**
 * The work's reading status in the user's library (to read, reading, read or cited), the same
 * in every graph. Without `onChange`, a note why it can't be set: `unavailable` is
 * 'signed-out' or 'locked' (not in the plan).
 */
function ReadingStatus({ status, onChange, unavailable, error }) {
  if (!onChange) {
    return (
      <p className="muted small">
        {unavailable === 'locked'
          ? `Reading status: ${NOT_IN_PLAN}.`
          : 'Log in to keep a reading list: mark works to read, read or cited.'}
      </p>
    );
  }
  return (
    <label className="reading-status">
      <span className="with-icon">
        <ReadingStatusIcon status={status} />
        Reading status
      </span>
      <select value={status ?? ''} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Not in my library</option>
        {READING_STATUSES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="error small">
          Couldn&rsquo;t save the status: {error}
        </span>
      )}
    </label>
  );
}

function DataSources({
  work,
  links,
  onSelect,
  namesFromWikidata = false,
  manualLinks = [],
  onRemoveManualLink,
}) {
  const cites = links.filter((link) => link.direction === 'cites');
  const citedBy = links.filter((link) => link.direction === 'cited-by');
  // Links only the user added are listed on their own, with a way to remove each.
  const elsewhere = links.filter(
    (link) =>
      link.providers.length > 0 &&
      !link.providers.includes('openalex') &&
      link.providers.some((name) => name !== 'manual'),
  );
  const onOpenAlex = work.providers.includes('openalex');
  const others = work.providers.filter((name) => name !== 'openalex');
  return (
    <section className="data-sources" aria-labelledby="data-sources-title">
      <h3 id="data-sources-title">Where the data comes from</h3>
      <p className="muted small">
        {work.manual
          ? 'Added by you; no database has it. Only you can see it.'
          : onOpenAlex
            ? `Record from OpenAlex${others.length ? `; citations also from ${listProviders(others)}` : ''}.`
            : `Known from a reference list deposited with ${listProviders(work.providers)}.`}
        {work.language &&
          ` Language ${
            work.languageProvider === 'crossref'
              ? 'as deposited with Crossref'
              : `as ${providerLabel(work.languageProvider)} detected it from the title and abstract`
          }.`}
        {namesFromWikidata && ' Authors’ names in other scripts from Wikidata.'}
      </p>
      {links.length > 0 && (
        <dl className="link-sources">
          {cites.length > 0 && (
            <div>
              <dt>Links to works it cites</dt>
              <dd>{providerSummary(cites)}</dd>
            </div>
          )}
          {citedBy.length > 0 && (
            <div>
              <dt>Links from works citing it</dt>
              <dd>{providerSummary(citedBy)}</dd>
            </div>
          )}
        </dl>
      )}
      {elsewhere.length > 0 && (
        <details>
          <summary>
            {elsewhere.length} {elsewhere.length === 1 ? 'link' : 'links'} OpenAlex doesn&rsquo;t
            have
          </summary>
          <ul className="elsewhere-links">
            {elsewhere.map(({ work: other, direction, providers }) => (
              <li key={`${direction}:${other.id}`}>
                <span className="muted small">{direction === 'cites' ? 'Cites' : 'Cited by'}</span>{' '}
                <button type="button" className="link-button" onClick={() => onSelect?.(other.id)}>
                  {other.title ?? 'Untitled'}
                </button>{' '}
                <span className="muted small">from {listProviders(providers)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {manualLinks.length > 0 && (
        <>
          <h4 className="small">Citations you added</h4>
          <ul className="elsewhere-links" aria-label="Citations you added">
            {manualLinks.map(({ link, other, direction }) => (
              <li key={link.id}>
                <span className="muted small">{direction === 'cites' ? 'Cites' : 'Cited by'}</span>{' '}
                {other ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onSelect?.(other.id)}
                  >
                    {other.title ?? 'Untitled'}
                  </button>
                ) : (
                  <span className="muted">a work not on this graph</span>
                )}{' '}
                {onRemoveManualLink && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onRemoveManualLink(link.id)}
                    aria-label={`Remove: ${direction === 'cites' ? 'cites' : 'cited by'} ${other?.title ?? 'a work'}`}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const yearOf = (work) => (work.year == null ? '' : ` (${work.year})`);

// Anchor titles in running text.
const anchorTitle = (anchor) => {
  const title = anchor?.title ?? 'Untitled';
  return `“${title.length > 60 ? `${title.slice(0, 59)}…` : title}”`;
};

/**
 * Looking for, and showing, the shortest path of citations from a work to an anchor it has no
 * path to on the graph. `targets` are those anchors ({ id, title }); with several, the user
 * picks one or the nearest (`choice`: an anchor ID or 'nearest', set with `onChoose`).
 * `result` is the last search's, with `result.targets` the anchors it searched for. With one
 * anchor on the graph (`many` false), it's just "the anchor".
 */
function PathToAnchor({
  targets = [],
  choice = 'nearest',
  onChoose,
  finding,
  result,
  onFind,
  onSelect,
  locked = false,
  many = false,
}) {
  const path = result?.path;
  // How to name the anchors a search was (or will be) for.
  const describe = (anchors) =>
    !many ? 'the anchor' : anchors.length === 1 ? anchorTitle(anchors[0]) : 'the nearest anchor';
  const chosen = choice === 'nearest' ? targets : targets.filter((t) => t.id === choice);
  const reached = path ? path[path.length - 1].work : null;
  const searched = describe(result?.targets ?? chosen);
  return (
    <div className="path-to-anchor">
      {path ? (
        <>
          <p className="small">
            Connected to {many ? anchorTitle(reached) : 'the anchor'} in {path.length - 1} step
            {path.length === 2 ? '' : 's'}:
          </p>
          <ol className="path-steps" aria-label={many ? 'Path to an anchor' : 'Path to the anchor'}>
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
                  {index === path.length - 1 ? (many ? ', an anchor' : ', the anchor') : ''}
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
        targets.length > 0 && (
          <>
            <p className="muted small">
              No citations on the graph link this work to{' '}
              {!many
                ? 'the anchor’s'
                : targets.length === 1
                  ? anchorTitle(targets[0])
                  : `${targets.length} of the anchors`}
              .
            </p>
            {many && targets.length > 1 && (
              <label className="path-target">
                Path to
                <select value={choice} onChange={(event) => onChoose(event.target.value)}>
                  <option value="nearest">The nearest of them</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.title ?? 'Untitled'}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              onClick={() => onFind(chosen.map((t) => t.id))}
              disabled={finding || locked}
            >
              {finding
                ? 'Finding a path…'
                : !many
                  ? 'Find shortest path to the anchor'
                  : targets.length === 1
                    ? 'Find shortest path to that anchor'
                    : 'Find shortest path'}
            </button>
            {locked && <p className="muted small">{NOT_IN_PLAN}.</p>}
            {result?.outcome === 'none' && (
              <p className="muted small">
                There&rsquo;s no path on OpenAlex: none of the {result.searched.toLocaleString()}{' '}
                works linked to this one, however distantly, reaches {searched}.
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

/**
 * Which anchors a work is near, on a graph with several (see anchorNeighborhoods): each with
 * its color, as on the graph. `anchors` are { id, index, title }, index being its place among
 * the anchors (which picks its color).
 */
function Neighborhood({ anchors, isAnchor }) {
  if (isAnchor) {
    const [self] = anchors;
    return (
      <p className="neighborhood small">
        <span className="anchor-swatch" style={{ '--swatch': `var(--anchor-${self.index + 1})` }} />
        Anchor {self.index + 1}
      </p>
    );
  }
  if (anchors.length === 0) {
    return <p className="neighborhood small muted">Not linked to an anchor</p>;
  }
  return (
    <div className="neighborhood small">
      <span className="muted">{anchors.length > 1 ? 'Shared by' : 'Near'}</span>
      <ul aria-label="Near anchors">
        {anchors.map((anchor) => (
          <li key={anchor.id}>
            <span
              className="anchor-swatch"
              style={{ '--swatch': `var(--anchor-${anchor.index + 1})` }}
            />
            {anchor.title}
          </li>
        ))}
      </ul>
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
  note = '',
  onNoteChange,
  signedIn = false,
  coCitedBy = null,
  onFindCoCitations,
  coCitationControl = null,
  findingCoCitations = false,
  coCitationResult = null,
  pathControl = null,
  anchorControl = null,
  neighborhood = null,
  manyAnchors = false,
  onMerged,
  referenceWarning = null,
  graphLinks = [],
  onSelectWork,
  readingStatus = null,
  onReadingStatusChange,
  readingStatusUnavailable = 'signed-out',
  readingStatusError = null,
  onAddCitation,
  addCitationError = null,
  graphWorks = [],
  manualLinks = [],
  onRemoveManualLink,
  onDeleteManualWork,
  onClose,
  inert = false,
}) {
  const fullyExpanded = expanded.has('citing') && expanded.has('cited');
  // A listed year set aside as implausible (see layoutYears) shows as a bound instead.
  const implausible = yearInfo?.listedYear != null;
  const year = implausible ? `Before ${yearInfo.citedFrom}` : (work.year ?? 'Year unknown');
  const byline = [year, work.venue, work.language && languageName(work.language)]
    .filter(Boolean)
    .join(' · ');
  const { label: typeLabel, Icon: TypeIcon } = sourceType(work.type);
  const expandable = canExpand(work);
  // Copies on the Internet Archive; for a work not on OpenAlex, also the work Crossref
  // matched its citation to.
  // Works the user added by hand are theirs alone: the server has nothing to look up.
  const archiveItems = useWorkLookup(getArchiveItems, work.id, NO_ITEMS, !work.manual);
  // Authors' names in other scripts, and links to them, from Wikidata.
  const authorNames = useWorkLookup(
    getAuthorNames,
    work.id,
    NO_ITEMS,
    expandable && work.authors.length > 0,
  );
  // Its reception over time: how many works cite it each year.
  const citationYears = useWorkLookup(
    getCitationsByYear,
    work.id,
    NO_ITEMS,
    expandable && (work.citedByCount ?? 0) > 0,
  );
  const authorLinks = authorNames.flatMap((entry) =>
    entry.links.map((link) => ({ ...link, name: entry.name })),
  );
  const matched = useWorkLookup(
    getCitationMatch,
    work.id,
    null,
    !expandable && !work.manual && !work.links.length,
  );
  const match = matched?.match ?? null;
  const mergedWork = matched?.work ?? null;
  useEffect(() => {
    if (mergedWork) onMerged?.(mergedWork);
  }, [mergedWork, onMerged]);
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
      <h2 id="details-title" lang={work.language ?? undefined}>
        {work.title ?? 'Untitled'}
      </h2>
      {(work.otherTitles ?? []).map((other) => (
        <OtherTitle key={other.title} other={other} work={work} />
      ))}
      {work.authors.length > 0 && <Authors authors={work.authors} names={authorNames} />}
      <p className="muted with-icon">
        <TypeIcon className="icon" aria-hidden="true" />
        <span>
          {typeLabel} · {byline}
        </span>
      </p>
      {work.topic && (
        <p className="muted small topic">
          Topic: {work.topic.name}
          {[work.topic.subfield?.name, work.topic.field?.name].filter(Boolean).length > 0 &&
            ` (${[work.topic.subfield?.name, work.topic.field?.name].filter(Boolean).join(', ')})`}
        </p>
      )}
      {neighborhood && <Neighborhood anchors={neighborhood} isAnchor={relation === 'anchor'} />}
      {referenceWarning && (
        <p className="reference-warning small with-icon">
          <TriangleAlert className="icon" aria-hidden="true" />
          <span>{describeWarning(referenceWarning)}</span>
        </p>
      )}
      {implausible && (
        <p className="muted small">
          OpenAlex gives {yearInfo.listedYear}, but works on this graph cite it from{' '}
          {yearInfo.citedFrom} on, so that&rsquo;s probably the year of a reprint or digitized copy.
        </p>
      )}
      {work.manual && onDeleteManualWork && (
        <div className="manual-work">
          <p className="muted small">
            You added this work; no database has it, so there are no citing or cited works to fetch.
            Add the citations you know of below.
          </p>
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Delete “${work.title}” and the citations you added to it?`)) {
                onDeleteManualWork();
              }
            }}
          >
            Delete this work
          </button>
        </div>
      )}
      {!expandable && !work.manual && (
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
      <CitationsByYear years={citationYears} />

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
          {manyAnchors ? 'Make this the only anchor' : 'Make this the anchor'}
        </button>
      )}
      {expandable && relation !== 'anchor' && anchorControl && (
        <>
          <button
            type="button"
            onClick={anchorControl.onAdd}
            disabled={busy || anchorControl.count >= anchorControl.limit}
          >
            Add as anchor
          </button>
          {anchorControl.count >= anchorControl.limit && (
            <p className="muted small">
              Your plan allows up to {anchorControl.limit} anchor
              {anchorControl.limit === 1 ? '' : 's'}.
            </p>
          )}
        </>
      )}
      {relation === 'anchor' && anchorControl && anchorControl.count > 1 && (
        <button type="button" onClick={anchorControl.onRemove} disabled={busy}>
          Remove anchor
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
            disabled={
              busy || findingCoCitations || coCitationControl.citers < 2 || coCitationControl.locked
            }
          >
            {findingCoCitations ? 'Finding co-citations…' : 'Find Co-Citations'}
          </button>
          {coCitationControl.locked && <p className="muted small">{NOT_IN_PLAN}.</p>}
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
      {pathControl && <PathToAnchor {...pathControl} many={manyAnchors} />}
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
      <ReadingStatus
        status={readingStatus}
        onChange={onReadingStatusChange}
        unavailable={readingStatusUnavailable}
        error={readingStatusError}
      />
      {onAddCitation && (
        // Keyed by work, so a half-filled form doesn't carry over to the next work selected.
        <AddCitation
          key={`add-citation:${work.id}`}
          work={work}
          onGraph={graphWorks}
          onAdd={onAddCitation}
          error={addCitationError}
        />
      )}
      {onNoteChange && (
        // Keyed by work, so a draft doesn't carry over to the next work selected.
        <WorkNote key={`note:${work.id}`} note={note} onChange={onNoteChange} signedIn={signedIn} />
      )}

      {(links.length > 0 || archiveItems.length > 0 || authorLinks.length > 0) && (
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
            {authorLinks.map((link) => (
              <li key={link.url}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {LINK_LABELS[link.kind] ?? link.kind}
                </a>{' '}
                <span className="muted small">{link.name}</span>
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

      <DataSources
        work={work}
        links={graphLinks}
        onSelect={onSelectWork}
        namesFromWikidata={authorNames.some((entry) => entry.otherNames.length > 0)}
        manualLinks={manualLinks}
        onRemoveManualLink={onRemoveManualLink}
      />

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

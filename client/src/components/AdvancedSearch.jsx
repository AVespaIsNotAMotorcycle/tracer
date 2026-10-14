import { ArrowLeft, Anchor, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { advancedSearch as defaultSearch, suggest as defaultSuggest } from '../api.js';
import { sourceType } from '../graph/sourceTypes.js';
import SuggestPicker from './SuggestPicker.jsx';

const PAGE_SIZE = 25;
const ABSTRACT_PREVIEW = 320;

const TEXT_FIELDS = [
  { key: 'any', label: 'Any field', hint: 'Title, abstract, full text and more' },
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author', hint: 'As printed, e.g. “E. P. Thompson”' },
  { key: 'abstract', label: 'Abstract' },
  { key: 'fulltext', label: 'Full text', hint: 'Only works whose full text OpenAlex has' },
];

// Types worth narrowing to, roughly most useful first for the humanities.
const TYPES = [
  'article',
  'book',
  'book-chapter',
  'review',
  'book-review',
  'dissertation',
  'reference-entry',
  'report',
  'preprint',
  'editorial',
  'letter',
  'conference-paper',
];

const LANGUAGES = [
  ['en', 'English'],
  ['fr', 'French'],
  ['de', 'German'],
  ['es', 'Spanish'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['pl', 'Polish'],
  ['sv', 'Swedish'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['zh', 'Chinese'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
];

const SORTS = [
  ['relevance', 'Relevance'],
  ['cited', 'Most cited'],
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
];

const EMPTY_FORM = {
  any: '',
  title: '',
  author: '',
  abstract: '',
  fulltext: '',
  venues: [],
  publishers: [],
  fromYear: '',
  toYear: '',
  types: [],
  language: '',
  minCitations: '',
  openAccess: false,
};

/** The API's criteria for a form; null if nothing in it narrows the search. */
function formCriteria(form, sort) {
  const criteria = {};
  for (const { key } of TEXT_FIELDS) if (form[key].trim()) criteria[key] = form[key].trim();
  if (form.venues.length) criteria.venueIds = form.venues.map((venue) => venue.id);
  if (form.publishers.length) criteria.publisherIds = form.publishers.map((p) => p.id);
  for (const key of ['fromYear', 'toYear', 'minCitations']) {
    if (String(form[key]).trim() !== '') criteria[key] = Number(form[key]);
  }
  if (form.types.length) criteria.types = form.types;
  if (form.language) criteria.language = form.language;
  if (form.openAccess) criteria.openAccess = true;
  if (Object.keys(criteria).length === 0) return null;
  return { ...criteria, sort };
}

const byline = (work) => {
  const names = work.authors.map((author) => author.name).filter(Boolean);
  if (names.length > 3) return `${names.slice(0, 3).join(', ')} et al.`;
  return names.join(', ');
};

const preview = (text) =>
  text.length > ABSTRACT_PREVIEW ? `${text.slice(0, ABSTRACT_PREVIEW - 1)}…` : text;

/**
 * Searches works by many fields at once, filling the page below the header. Results are
 * picked with checkboxes; the picks (kept across searches) then build a graph, the first as
 * its anchor and the rest added and expanded, or all of them as anchors (`onBuild(ids,
 * { asAnchors: true })`, up to `anchorLimit`), or join the graph on screen.
 *
 * Stays mounted while hidden, so the form, results and picks are still there when it's
 * reopened. The picks are listed in a column on the right, with the actions below them.
 */
export default function AdvancedSearch({
  hidden,
  initialQuery = '',
  onClose,
  onBuild,
  onAdd,
  anchorLimit = 2,
  hasGraph,
  onGraph,
  busy,
  search = defaultSearch,
  suggest = defaultSuggest,
}) {
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, any: initialQuery }));
  const [sort, setSort] = useState('relevance');
  // The criteria the results are for, and what's loaded of them.
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  // Picked works, in order; the first becomes the anchor.
  const [picked, setPicked] = useState([]);
  const controller = useRef(null);
  const firstField = useRef(null);
  const resultsHeading = useRef(null);

  // Focus the first field on opening, and return focus to what opened the page on closing.
  useEffect(() => {
    if (hidden) return undefined;
    const opener = document.activeElement;
    firstField.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [hidden]);

  useEffect(() => {
    if (hidden) return undefined;
    const handleKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [hidden, onClose]);

  useEffect(() => () => controller.current?.abort(), []);

  const setField = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));
  const toggleType = (key) =>
    setForm((prev) => ({
      ...prev,
      types: prev.types.includes(key)
        ? prev.types.filter((type) => type !== key)
        : [...prev.types, key],
    }));

  const yearsBackwards =
    form.fromYear !== '' && form.toYear !== '' && Number(form.fromYear) > Number(form.toYear);
  // Relevance needs words to rank by; without them, the most cited come first.
  const hasText = TEXT_FIELDS.some(({ key }) => form[key].trim());
  const shownSort = sort === 'relevance' && !hasText ? 'cited' : sort;
  const criteria = formCriteria(form, shownSort);

  /** Loads a page of `forCriteria`: page 1 replaces the results, later pages extend them. */
  const run = async (forCriteria, page = 1) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setSearching(true);
    setError(null);
    try {
      const { works, total } = await search(forCriteria, {
        limit: PAGE_SIZE,
        page,
        signal: current.signal,
      });
      if (current.signal.aborted) return;
      setResults((prev) =>
        page === 1 || !prev
          ? { criteria: forCriteria, works, total, page }
          : {
              ...prev,
              // A work can shift between pages if the index changes meanwhile.
              works: [
                ...prev.works,
                ...works.filter((w) => !prev.works.some((p) => p.id === w.id)),
              ],
              total,
              page,
            },
      );
      if (page === 1) resultsHeading.current?.focus();
    } catch (err) {
      if (!current.signal.aborted) setError(err.message);
    } finally {
      if (!current.signal.aborted) setSearching(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    if (criteria && !yearsBackwards) run(criteria);
  };

  const handleSort = (event) => {
    const next = event.target.value;
    setSort(next);
    if (results) run({ ...results.criteria, sort: next });
  };

  const isPicked = (id) => picked.some((work) => work.id === id);
  const togglePick = (work) =>
    setPicked((prev) =>
      prev.some((p) => p.id === work.id) ? prev.filter((p) => p.id !== work.id) : [...prev, work],
    );
  const makeAnchor = (id) =>
    setPicked((prev) => [prev.find((p) => p.id === id), ...prev.filter((p) => p.id !== id)]);

  const finish = (action, extra) => {
    action(
      picked.map((work) => work.id),
      extra,
    );
    setPicked([]);
  };

  // OpenAlex pages through the first 10,000 results only.
  const more = results && results.works.length < Math.min(results.total, 10000);

  return (
    <section className="advanced-search" hidden={hidden} aria-labelledby="advanced-search-heading">
      <div className="advanced-header">
        <button type="button" className="with-icon" onClick={onClose}>
          <ArrowLeft className="icon" aria-hidden="true" />
          {hasGraph ? 'Back to graph' : 'Back'}
        </button>
        <h2 id="advanced-search-heading">Advanced search</h2>
      </div>

      {/* Chosen works get a column of their own on the right (a bar at the bottom on narrow
          screens), so a long list doesn't squeeze the results. */}
      <div className={`advanced-body${picked.length > 0 ? ' has-picked' : ''}`}>
        <form className="advanced-form" onSubmit={handleSubmit} aria-label="Search fields">
          {TEXT_FIELDS.map(({ key, label, hint }, index) => (
            <div key={key} className="field">
              <label htmlFor={`advanced-${key}`}>{label}</label>
              <input
                id={`advanced-${key}`}
                ref={index === 0 ? firstField : undefined}
                type="search"
                value={form[key]}
                onChange={setField(key)}
                autoComplete="off"
                aria-describedby={hint ? `advanced-${key}-hint` : undefined}
              />
              {hint && (
                <span id={`advanced-${key}-hint`} className="muted small">
                  {hint}
                </span>
              )}
            </div>
          ))}

          <SuggestPicker
            kind="venue"
            label="Journal or series"
            placeholder="e.g. Past & Present"
            picked={form.venues}
            onChange={(venues) => setForm((prev) => ({ ...prev, venues }))}
            suggest={suggest}
          />
          <SuggestPicker
            kind="publisher"
            label="Publisher"
            placeholder="e.g. Cambridge University Press"
            picked={form.publishers}
            onChange={(publishers) => setForm((prev) => ({ ...prev, publishers }))}
            suggest={suggest}
          />

          <div className="field-row">
            <label className="field">
              Published from
              <input
                type="number"
                inputMode="numeric"
                value={form.fromYear}
                onChange={setField('fromYear')}
                aria-invalid={yearsBackwards || undefined}
              />
            </label>
            <label className="field">
              to
              <input
                type="number"
                inputMode="numeric"
                value={form.toYear}
                onChange={setField('toYear')}
                aria-invalid={yearsBackwards || undefined}
              />
            </label>
          </div>
          {yearsBackwards && (
            <p className="error small" role="alert">
              The first year is after the second.
            </p>
          )}

          <fieldset className="type-filter">
            <legend>Source types</legend>
            <ul className="source-types">
              {TYPES.map((key) => {
                const { label, Icon } = sourceType(key);
                return (
                  <li key={key}>
                    <label>
                      <input
                        type="checkbox"
                        checked={form.types.includes(key)}
                        onChange={() => toggleType(key)}
                      />
                      <Icon className="icon" aria-hidden="true" />
                      <span>{label}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <span className="muted small">None checked: any type.</span>
          </fieldset>

          <div className="field-row">
            <label className="field">
              Language
              <select value={form.language} onChange={setField('language')}>
                <option value="">Any</option>
                {LANGUAGES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Cited at least
              <input
                type="number"
                min={0}
                inputMode="numeric"
                value={form.minCitations}
                onChange={setField('minCitations')}
              />
            </label>
          </div>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={form.openAccess}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, openAccess: event.target.checked }))
              }
            />
            Open access only
          </label>

          <div className="advanced-actions">
            <button type="submit" className="primary" disabled={!criteria || yearsBackwards}>
              {searching && !results ? 'Searching…' : 'Search'}
            </button>
            <button type="button" onClick={() => setForm(EMPTY_FORM)}>
              Clear fields
            </button>
          </div>
        </form>

        <div className="advanced-results">
          <div className="advanced-results-header">
            <h3 ref={resultsHeading} tabIndex={-1}>
              {results
                ? `${results.total.toLocaleString()} work${results.total === 1 ? '' : 's'} found`
                : 'Results'}
            </h3>
            <label className="sort">
              Sort by
              <select value={shownSort} onChange={handleSort}>
                {SORTS.map(([key, label]) => (
                  <option key={key} value={key} disabled={key === 'relevance' && !hasText}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {!results && !error && (
            <p className="muted">
              Fill in any fields and search. Every field you fill must match. Check the works you
              want, then build a graph from them.
            </p>
          )}
          {results?.works.length === 0 && <p className="muted">No works match all of these.</p>}

          {results?.works.length > 0 && (
            <ul
              className="advanced-result-list"
              aria-label="Advanced search results"
              aria-busy={searching}
            >
              {results.works.map((work) => {
                const { label, Icon } = sourceType(work.type);
                const checked = isPicked(work.id);
                return (
                  <li key={work.id} className={checked ? 'picked' : undefined}>
                    <label>
                      <input type="checkbox" checked={checked} onChange={() => togglePick(work)} />
                      <span className="result-main">
                        <span className="result-title">
                          <Icon className="icon result-icon" aria-hidden="true" />
                          <span className="visually-hidden">{`${label}: `}</span>
                          {work.title ?? 'Untitled'}
                        </span>
                        <span className="muted small">
                          {[byline(work), work.year, work.venue].filter(Boolean).join(' · ')}
                        </span>
                        {work.abstract && (
                          <span className="result-abstract small">{preview(work.abstract)}</span>
                        )}
                        <span className="result-meta small">
                          <span>{label}</span>
                          {work.citedByCount != null && (
                            <span>Cited by {work.citedByCount.toLocaleString()}</span>
                          )}
                          {onGraph.has(work.id) && <span className="tag">On the graph</span>}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {more && (
            <button
              type="button"
              className="load-more"
              onClick={() => run(results.criteria, results.page + 1)}
              disabled={searching}
            >
              {searching
                ? 'Loading…'
                : `Show more (${results.works.length} of ${results.total.toLocaleString()})`}
            </button>
          )}
        </div>

        {picked.length > 0 && (
          <div className="picked-panel" role="region" aria-label="Chosen works">
            <div className="picked-summary">
              <strong>
                {picked.length} work{picked.length === 1 ? '' : 's'} chosen
              </strong>
              <span className="muted small">
                {picked.length > 1 || !hasGraph
                  ? 'A new graph is built around the anchor. The others are added and expanded. '
                  : ''}
                Chosen works are pinned, so filters don’t hide them.
              </span>
            </div>
            <ul className="chips">
              {picked.map((work, index) => (
                <li key={work.id} className={`chip${index === 0 ? ' anchor' : ''}`}>
                  {index === 0 ? (
                    <Anchor className="icon" aria-label="Anchor" />
                  ) : (
                    <button
                      type="button"
                      className="chip-action"
                      onClick={() => makeAnchor(work.id)}
                      aria-label={`Make “${work.title ?? 'Untitled'}” the anchor`}
                      title="Make this the anchor"
                    >
                      <Anchor className="icon" aria-hidden="true" />
                    </button>
                  )}
                  <span className="chip-title">{work.title ?? 'Untitled'}</span>
                  <button
                    type="button"
                    className="chip-remove"
                    onClick={() => togglePick(work)}
                    aria-label={`Remove “${work.title ?? 'Untitled'}”`}
                  >
                    <X className="icon" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="picked-actions">
              <button type="button" className="link-button" onClick={() => setPicked([])}>
                Clear
              </button>
              {hasGraph && (
                <button type="button" onClick={() => finish(onAdd)} disabled={busy}>
                  Add to current graph
                </button>
              )}
              {picked.length > 1 && (
                <button
                  type="button"
                  onClick={() => finish(onBuild, { asAnchors: true })}
                  disabled={busy || picked.length > anchorLimit}
                  title={
                    picked.length > anchorLimit
                      ? `Your plan allows up to ${anchorLimit} anchors`
                      : undefined
                  }
                >
                  Build with these as anchors
                </button>
              )}
              <button
                type="button"
                className="primary"
                onClick={() => finish(onBuild)}
                disabled={busy}
              >
                {hasGraph ? 'Build new graph' : 'Build graph'}
              </button>
            </div>
            {picked.length > 1 && picked.length > anchorLimit && (
              <p className="muted small">
                Your plan allows up to {anchorLimit} anchors: choose fewer to build with them all as
                anchors.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

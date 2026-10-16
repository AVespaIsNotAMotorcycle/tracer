import { useId, useState } from 'react';

const MAX_MATCHES = 8;

const TYPES = [
  { value: 'book', label: 'Book' },
  { value: 'article', label: 'Article' },
  { value: 'book-chapter', label: 'Book chapter' },
  { value: 'dissertation', label: 'Dissertation' },
  { value: 'other', label: 'Other (archival source, pamphlet, …)' },
];

const squash = (text) => (text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Records a citation the databases missed, from or to the selected work: to a work on the graph
 * (picked by title), a work Tracer can look up (a DOI or OpenAlex ID), or a work no database
 * has (described here). It's the user's own, shown only to them. `onAdd({ direction, target })`
 * resolves to true when it's saved; `error` says why the last attempt wasn't.
 *
 * @param {object} props
 * @param {object} props.work  The selected work.
 * @param {object[]} props.onGraph  The other works on the graph, to pick from.
 * @param {(request: { direction: 'cites' | 'cited-by', target: { kind: 'graph', id: string }
 *   | { kind: 'id', value: string } | { kind: 'new', fields: object } }) => Promise<boolean>}
 *   props.onAdd
 * @param {string | null} [props.error]
 */
export default function AddCitation({ work, onGraph, onAdd, error = null }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState('cites');
  const [mode, setMode] = useState('graph');
  const [query, setQuery] = useState('');
  const [externalId, setExternalId] = useState('');
  const [fields, setFields] = useState({ title: '', authors: '', year: '', type: 'other' });
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(null);

  const matches = query.trim()
    ? onGraph
        .filter((other) => squash(other.title).includes(squash(query.trim())))
        .slice(0, MAX_MATCHES)
    : [];

  const add = async (target, label) => {
    setBusy(true);
    setAdded(null);
    const ok = await onAdd({ direction, target });
    setBusy(false);
    if (!ok) return;
    setAdded(label);
    setQuery('');
    setExternalId('');
    setFields({ title: '', authors: '', year: '', type: 'other' });
  };

  const addNew = (event) => {
    event.preventDefault();
    const year = fields.year.trim() ? Number(fields.year) : null;
    add(
      {
        kind: 'new',
        fields: {
          title: fields.title,
          authors: fields.authors
            .split(/[;\n]/)
            .map((name) => name.trim())
            .filter(Boolean),
          year: Number.isInteger(year) ? year : null,
          type: fields.type,
        },
      },
      fields.title.trim(),
    );
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Add a citation the databases missed
      </button>
    );
  }

  return (
    <fieldset className="add-citation">
      <legend>Add a citation the databases missed</legend>
      <p className="muted small">Only you can see citations and works you add.</p>
      <label>
        <select value={direction} onChange={(event) => setDirection(event.target.value)}>
          <option value="cites">This work cites…</option>
          <option value="cited-by">This work is cited by…</option>
        </select>
      </label>
      <div className="add-citation-modes" role="radiogroup" aria-label="Which work">
        {[
          ['graph', 'A work on the graph'],
          ['id', 'A DOI or OpenAlex ID'],
          ['new', 'A work no database has'],
        ].map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name={`${id}-mode`}
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {label}
          </label>
        ))}
      </div>

      {mode === 'graph' && (
        <>
          <label>
            Title
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Type part of its title"
            />
          </label>
          {matches.length > 0 && (
            <ul className="add-citation-matches" aria-label="Works on the graph">
              {matches.map((other) => (
                <li key={other.id}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => add({ kind: 'graph', id: other.id }, other.title ?? 'Untitled')}
                  >
                    {other.title ?? 'Untitled'}
                    {other.year ? ` (${other.year})` : ''}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() && matches.length === 0 && (
            <p className="muted small">No work on the graph has that in its title.</p>
          )}
        </>
      )}

      {mode === 'id' && (
        <form
          className="add-citation-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (externalId.trim()) add({ kind: 'id', value: externalId.trim() }, externalId.trim());
          }}
        >
          <label>
            DOI or OpenAlex ID
            <input
              value={externalId}
              onChange={(event) => setExternalId(event.target.value)}
              placeholder="10.1093/past/50.1.76"
            />
          </label>
          <button type="submit" disabled={busy || !externalId.trim()}>
            Add
          </button>
        </form>
      )}

      {mode === 'new' && (
        <form className="add-citation-new" onSubmit={addNew}>
          <label>
            Title
            <input
              required
              value={fields.title}
              onChange={(event) => setFields({ ...fields, title: event.target.value })}
            />
          </label>
          <label>
            Authors <span className="muted small">(separate with semicolons)</span>
            <input
              value={fields.authors}
              onChange={(event) => setFields({ ...fields, authors: event.target.value })}
            />
          </label>
          <div className="add-citation-row">
            <label>
              Year
              <input
                inputMode="numeric"
                value={fields.year}
                onChange={(event) => setFields({ ...fields, year: event.target.value })}
              />
            </label>
            <label>
              Kind
              <select
                value={fields.type}
                onChange={(event) => setFields({ ...fields, type: event.target.value })}
              >
                {TYPES.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" disabled={busy || !fields.title.trim()}>
            Add
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="error small">
          Couldn&rsquo;t add it: {error}
        </p>
      )}
      {added && !error && (
        <p role="status" className="small">
          Added: {work.title ?? 'This work'} {direction === 'cites' ? 'cites' : 'is cited by'}{' '}
          &ldquo;{added}&rdquo;.
        </p>
      )}
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Done
      </button>
    </fieldset>
  );
}

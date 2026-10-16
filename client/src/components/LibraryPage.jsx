import { useEffect, useState } from 'react';
import * as defaultApi from '../api.js';
import { NOT_IN_PLAN } from '../auth/entitlements.js';
import { READING_STATUSES } from '../library/readingStatus.js';
import ReadingStatusIcon from '../library/ReadingStatusIcon.jsx';
import { shareableId } from '../urlState.js';
import Header from './Header.jsx';

// Sections of the library, in reading order, then works with notes but no status.
const SECTIONS = [
  ...READING_STATUSES,
  { value: null, label: 'Noted', hint: 'Works you’ve written notes on in a saved graph.' },
];

/**
 * The signed-in user's library: every work they've given a reading status, across all their
 * graphs, and every work they've noted in a saved graph, grouped by status. Each opens a graph
 * built around it; statuses can be changed here, and each note links to its graph.
 */
export default function LibraryPage({ auth, api = defaultApi }) {
  return (
    <div className="page">
      <Header auth={auth} />
      <main className="profile">
        <h2>My library</h2>
        {auth.user === undefined ? (
          <p className="muted">Loading…</p>
        ) : !auth.user ? (
          <p className="muted">Log in to see your library.</p>
        ) : !auth.can('library') ? (
          <p className="muted">{NOT_IN_PLAN}.</p>
        ) : (
          <Library api={api} />
        )}
      </main>
    </div>
  );
}

function Library({ api }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    api
      .getLibrary()
      .then((found) => current && setEntries(found))
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [api]);

  if (error) {
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  }
  if (!entries) return <p className="muted">Loading…</p>;
  if (entries.length === 0) {
    return (
      <p className="muted">
        Nothing here yet. In a work&rsquo;s details on the graph, set its reading status (to read,
        reading, read or cited) or add a note, and it&rsquo;s listed here.
      </p>
    );
  }

  // A status change keeps the work where it is until the page reloads, so it doesn't jump.
  const changeStatus = async (workId, status) => {
    const before = entries;
    setEntries((list) => list.map((e) => (e.workId === workId ? { ...e, status } : e)));
    setError(null);
    try {
      await api.setReadingStatus(workId, status);
    } catch (err) {
      setEntries(before);
      setError(err.message);
    }
  };

  return SECTIONS.map(({ value, label, hint }) => {
    const items = entries.filter((entry) => (entry.status ?? null) === value);
    if (items.length === 0) return null;
    return (
      <section key={label} className="library-section" aria-labelledby={`library-${label}`}>
        <h3 id={`library-${label}`} className="with-icon">
          <ReadingStatusIcon status={value} />
          {label} <span className="muted">{items.length}</span>
        </h3>
        {hint && <p className="muted small">{hint}</p>}
        <ul className="saved-graphs" aria-label={label}>
          {items.map((entry) => (
            <LibraryItem key={entry.workId} entry={entry} onStatusChange={changeStatus} />
          ))}
        </ul>
      </section>
    );
  });
}

function LibraryItem({ entry, onStatusChange }) {
  const { work, notes } = entry;
  const title = work?.title ?? 'A work no longer in Tracer’s database';
  const byline = work
    ? [work.authors.slice(0, 3).join(', '), work.year, work.venue].filter(Boolean).join(' · ')
    : null;
  return (
    <li>
      {work ? (
        <a className="graph-name" href={`/?anchor=${encodeURIComponent(shareableId(work))}`}>
          {title}
        </a>
      ) : (
        <span className="graph-name">{title}</span>
      )}
      {byline && <span className="muted small">{byline}</span>}
      {notes.map((note) => (
        <p key={note.graphId} className="library-note">
          <span className="muted small">
            Note in <a href={`/?graph=${note.graphId}`}>{note.graphName}</a>:
          </span>{' '}
          {note.body}
        </p>
      ))}
      <label className="graph-actions">
        <span className="muted small">Reading status</span>
        <select
          value={entry.status ?? ''}
          onChange={(event) => onStatusChange(entry.workId, event.target.value || null)}
          aria-label={`Reading status of ${title}`}
        >
          <option value="">Not in my library</option>
          {READING_STATUSES.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </li>
  );
}

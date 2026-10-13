import { useEffect, useState } from 'react';
import * as defaultApi from '../api.js';
import Header from './Header.jsx';

const MAX_NAME_LENGTH = 120;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** The signed-in user's saved graphs: open, rename or delete each one. */
export default function ProfilePage({ auth, api = defaultApi }) {
  return (
    <div className="page">
      <Header auth={auth} />
      <main className="profile">
        <h2>My graphs</h2>
        {auth.user === undefined ? (
          <p className="muted">Loading…</p>
        ) : auth.user ? (
          <SavedGraphs api={api} />
        ) : (
          <p className="muted">Log in to see your saved graphs.</p>
        )}
      </main>
    </div>
  );
}

function SavedGraphs({ api }) {
  const [graphs, setGraphs] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let current = true;
    api
      .listGraphs()
      .then((found) => current && setGraphs(found))
      .catch((err) => current && setError(err.message));
    return () => {
      current = false;
    };
  }, [api]);

  if (error)
    return (
      <p role="alert" className="error">
        {error}
      </p>
    );
  if (!graphs) return <p className="muted">Loading…</p>;
  if (graphs.length === 0) {
    return (
      <p className="muted">
        No saved graphs yet. <a href="/">Build a graph</a> and use “Save graph” to keep it here.
      </p>
    );
  }

  const replace = (graph) =>
    setGraphs((list) => list.map((g) => (g.id === graph.id ? { ...g, ...graph } : g)));
  const remove = (id) => setGraphs((list) => list.filter((g) => g.id !== id));

  return (
    <ul className="saved-graphs" aria-label="Saved graphs">
      {graphs.map((graph) => (
        <SavedGraphItem
          key={graph.id}
          graph={graph}
          api={api}
          onRenamed={replace}
          onDeleted={() => remove(graph.id)}
        />
      ))}
    </ul>
  );
}

function SavedGraphItem({ graph, api, onRenamed, onDeleted }) {
  const [mode, setMode] = useState(null); // 'rename' | 'delete' | null
  const [name, setName] = useState(graph.name);
  const [error, setError] = useState(null);
  const [working, setWorking] = useState(false);

  const run = async (action) => {
    setWorking(true);
    setError(null);
    try {
      await action();
      setMode(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <li>
      {mode === 'rename' ? (
        <form
          className="rename"
          onSubmit={(event) => {
            event.preventDefault();
            run(async () => onRenamed(await api.renameGraph(graph.id, name)));
          }}
        >
          <label className="visually-hidden" htmlFor={`name-${graph.id}`}>
            Name
          </label>
          <input
            id={`name-${graph.id}`}
            value={name}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" className="primary" disabled={working}>
            Save name
          </button>
          <button
            type="button"
            onClick={() => {
              setName(graph.name);
              setMode(null);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <a href={`/?graph=${encodeURIComponent(graph.id)}`} className="graph-name">
          {graph.name}
        </a>
      )}
      <span className="muted small">
        {[
          graph.anchor?.title && `Anchor: ${graph.anchor.title}`,
          `Updated ${dateFormat.format(new Date(graph.updatedAt))}`,
          graph.expandedCount ? `${graph.expandedCount} expanded` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {mode === 'delete' ? (
        <div className="graph-actions">
          <span>Delete “{graph.name}”?</span>
          <button
            type="button"
            className="danger"
            disabled={working}
            onClick={() =>
              run(async () => {
                await api.deleteGraph(graph.id);
                onDeleted();
              })
            }
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode(null)}>
            Cancel
          </button>
        </div>
      ) : (
        mode === null && (
          <div className="graph-actions">
            <a href={`/?graph=${encodeURIComponent(graph.id)}`}>Open</a>
            <button type="button" onClick={() => setMode('rename')}>
              Rename
            </button>
            <button type="button" onClick={() => setMode('delete')}>
              Delete
            </button>
          </div>
        )
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </li>
  );
}

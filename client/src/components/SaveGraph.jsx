import { useId, useState } from 'react';
import Modal from './Modal.jsx';

const MAX_NAME_LENGTH = 120;

/**
 * The "Save graph" button over the graph, and its dialog for naming the graph. A graph opened
 * from (or already saved as) a saved graph can be updated in place or saved as a new one.
 * Signed out, it says to log in instead, and without `canSave` (the plan's saveGraphs) that
 * saving isn't included. Beside it, the "Auto-save" checkbox (`autoSave`,
 * `onAutoSaveChange`) saves every change as it happens, with `autoSaveStatus` ({ state:
 * 'saving' | 'saved' | 'error', message? }) shown in place of the last save's message.
 */
export default function SaveGraph({
  user,
  canSave = true,
  savedGraph,
  defaultName,
  disabled,
  onSave,
  autoSave = false,
  autoSaveStatus = null,
  onAutoSaveChange,
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(null);

  if (user === undefined) return null;
  if (!user) return <span className="muted small">Log in to save this graph</span>;
  if (!canSave) {
    return <span className="muted small">Saving graphs isn’t included in your plan</span>;
  }

  const status = autoSaveStatus
    ? {
        saving: 'Saving…',
        saved: 'All changes saved',
        error: `Couldn’t save: ${autoSaveStatus.message}`,
      }[autoSaveStatus.state]
    : message;

  return (
    <>
      {status && (
        <span
          role="status"
          className={autoSaveStatus?.state === 'error' ? 'error small' : 'muted small'}
        >
          {status}
        </span>
      )}
      {onAutoSaveChange && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={autoSave}
            // Turning it on for an unsaved graph saves it, which waits for the graph.
            disabled={!savedGraph && !autoSave && disabled}
            onChange={(event) => {
              setMessage(null);
              onAutoSaveChange(event.target.checked);
            }}
          />
          Auto-save
        </label>
      )}
      <button
        type="button"
        className="primary"
        disabled={disabled}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}
      >
        Save graph
      </button>
      {open && (
        <SaveDialog
          savedGraph={savedGraph}
          defaultName={savedGraph?.name ?? defaultName}
          onClose={() => setOpen(false)}
          onSave={async (name, asNew) => {
            const saved = await onSave(name, asNew);
            setOpen(false);
            setMessage(`Saved as “${saved.name}”`);
          }}
        />
      )}
    </>
  );
}

function SaveDialog({ savedGraph, defaultName, onClose, onSave }) {
  const titleId = useId();
  const [name, setName] = useState(defaultName ?? '');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const save = async (asNew) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(name, asNew);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal titleId={titleId} onClose={onClose}>
      <h2 id={titleId}>Save graph</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(false);
        }}
      >
        <label>
          Name
          <input
            value={name}
            maxLength={MAX_NAME_LENGTH}
            placeholder="Untitled graph"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="muted small">
          Saves the anchor, depth and size, filters, view, and the works you expanded.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          {savedGraph && (
            <button type="button" disabled={saving} onClick={() => save(true)}>
              Save as new
            </button>
          )}
          <button type="submit" className="primary" disabled={saving}>
            {saving ? 'Saving…' : savedGraph ? 'Update' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

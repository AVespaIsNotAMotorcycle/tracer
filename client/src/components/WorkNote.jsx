import { NotebookPen } from 'lucide-react';
import { useId, useState } from 'react';

export const MAX_NOTE_LENGTH = 10_000;

/**
 * The user's note on a work, in its details: shown as written, with Edit and Delete, or an
 * "Add note" button. Edits are a draft until saved (Save, or Ctrl/⌘+Enter; Escape cancels),
 * so typing doesn't redraw the graph. `onChange('')` deletes the note.
 */
export default function WorkNote({ note = '', onChange, signedIn = false }) {
  const [draft, setDraft] = useState(null);
  const id = useId();
  const editing = draft != null;

  const save = () => {
    onChange(draft.trim() ? draft : '');
    setDraft(null);
  };

  if (editing) {
    return (
      <form
        className="work-note"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor={id} className="with-icon">
          <NotebookPen className="icon" aria-hidden="true" />
          <span>Note</span>
        </label>
        <textarea
          id={id}
          value={draft}
          rows={5}
          maxLength={MAX_NOTE_LENGTH}
          // Opened by the user to type in.
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(null);
            }
          }}
        />
        <p className="muted small">
          {signedIn
            ? 'Kept when you save the graph.'
            : 'Log in and save the graph to keep its notes.'}
        </p>
        <div className="button-row">
          <button type="submit" className="primary">
            Save note
          </button>
          <button type="button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (!note) {
    return (
      <button type="button" className="with-icon" onClick={() => setDraft('')}>
        <NotebookPen className="icon" aria-hidden="true" />
        <span>Add note</span>
      </button>
    );
  }

  return (
    <section className="work-note" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="with-icon">
        <NotebookPen className="icon" aria-hidden="true" />
        <span>Note</span>
      </h3>
      <p className="note-body">{note}</p>
      <div className="button-row">
        <button type="button" onClick={() => setDraft(note)}>
          Edit note
        </button>
        <button type="button" onClick={() => onChange('')}>
          Delete note
        </button>
      </div>
    </section>
  );
}

import { X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { suggest as defaultSuggest } from '../api.js';

// Wait this long after typing stops before asking for suggestions.
const DEBOUNCE_MS = 250;
const MAX_PICKED = 20;

/**
 * Picks venues or publishers (`kind`) by name, as a combobox: typing suggests matching names,
 * and picked ones show as removable chips. A search matches works in any of them.
 *
 * @param {{ kind: 'venue' | 'publisher', label: string, placeholder?: string,
 *   picked: { id: string, name: string }[], onChange: (picked: object[]) => void,
 *   suggest?: typeof defaultSuggest }} props
 */
export default function SuggestPicker({
  kind,
  label,
  placeholder,
  picked,
  onChange,
  suggest = defaultSuggest,
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState(null);

  const query = text.trim();
  useEffect(() => {
    if (query.length < 2) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      suggest(kind, query, { signal: controller.signal })
        .then((found) => {
          setSuggestions(found);
          setActive(-1);
          setError(null);
        })
        .catch((err) => {
          if (!controller.signal.aborted) setError(err.message);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [kind, query, suggest]);

  const pickedIds = new Set(picked.map((item) => item.id));
  const shown = query.length < 2 ? [] : suggestions.filter((item) => !pickedIds.has(item.id));
  const expanded = open && shown.length > 0;

  const pick = (item) => {
    if (picked.length < MAX_PICKED) onChange([...picked, { id: item.id, name: item.name }]);
    setText('');
    setSuggestions([]);
    setOpen(false);
  };

  const handleKeyDown = (event) => {
    if (event.key === 'ArrowDown' && shown.length) {
      event.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % shown.length);
    } else if (event.key === 'ArrowUp' && shown.length) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? shown.length - 1 : i - 1));
    } else if (event.key === 'Enter' && expanded && active >= 0) {
      // Pick the suggestion instead of submitting the search.
      event.preventDefault();
      pick(shown[active]);
    } else if (event.key === 'Escape' && expanded) {
      // Close the list, not the page.
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="suggest-picker">
      <label htmlFor={`${id}-input`}>{label}</label>
      {picked.length > 0 && (
        <ul className="chips" aria-label={`Chosen ${label.toLowerCase()}`}>
          {picked.map((item) => (
            <li key={item.id} className="chip">
              <span>{item.name}</span>
              <button
                type="button"
                className="chip-remove"
                onClick={() => onChange(picked.filter((other) => other.id !== item.id))}
                aria-label={`Remove ${item.name}`}
              >
                <X className="icon" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="suggest-field">
        <input
          id={`${id}-input`}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${id}-${active}` : undefined}
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Late enough for a click on a suggestion to land first.
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
        />
        <ul id={`${id}-list`} role="listbox" className="suggestions" hidden={!expanded}>
          {shown.map((item, index) => (
            <li
              key={item.id}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(item)}
            >
              <span>{item.name}</span>
              {item.hint && <span className="muted small">{item.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

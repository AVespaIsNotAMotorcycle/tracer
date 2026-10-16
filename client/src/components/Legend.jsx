import { NotebookPen, Pin, TriangleAlert } from 'lucide-react';
import { COLOR_SCHEMES, FIELD_LEVELS } from '../graph/colorSchemes.js';
import { READING_STATUSES } from '../library/readingStatus.js';
import ReadingStatusIcon from '../library/ReadingStatusIcon.jsx';

const short = (text, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The graph's legend, with the color scheme chosen above it: by relation to the anchor
 * (citing or cited), by anchor neighborhood (each anchor's hue, tints for works near one,
 * wedges for works near several), or by academic field (`fields`: the most common fields at
 * `fieldLevel`, each in a field color, then how many works are in other fields or have no
 * topic). Then the marks every scheme shares: rings and badges.
 *
 * @param {object} props
 * @param {'relation' | 'neighborhood' | 'field'} props.scheme
 * @param {(scheme: string) => void} props.onSchemeChange
 * @param {string} props.fieldLevel
 * @param {(level: string) => void} props.onFieldLevelChange
 * @param {object[]} props.anchorWorks  The anchors, in order.
 * @param {{ slot: number, name: string, count: number }[]} props.fields
 * @param {number} props.otherFields  Works in fields without a color of their own.
 * @param {number} props.noTopic  Works OpenAlex gives no topic.
 * @param {boolean} props.coCited  Whether any works are ringed as co-citations.
 * @param {boolean} props.warnings  Whether any works carry a missing-references badge.
 * @param {Set<string>} props.statuses  Reading statuses works on the graph have.
 */
export default function Legend({
  scheme,
  onSchemeChange,
  fieldLevel,
  onFieldLevelChange,
  anchorWorks,
  fields = [],
  otherFields = 0,
  noTopic = 0,
  coCited = false,
  warnings = false,
  statuses = new Set(),
}) {
  const level = FIELD_LEVELS.find((entry) => entry.value === fieldLevel) ?? FIELD_LEVELS[1];
  const many = anchorWorks.length > 1;
  return (
    <section className="panel legend" aria-label="Legend">
      <div className="legend-controls">
        <label>
          Color scheme
          <select value={scheme} onChange={(event) => onSchemeChange(event.target.value)}>
            {COLOR_SCHEMES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {scheme === 'field' && (
          <label>
            Level
            <select value={fieldLevel} onChange={(event) => onFieldLevelChange(event.target.value)}>
              {FIELD_LEVELS.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {scheme === 'neighborhood' && (
        <>
          {/* Each anchor, then works near several or none. */}
          {anchorWorks.map((work, index) => (
            <span key={work.id} className="legend-anchor">
              <i className="anchor-swatch" style={{ '--swatch': `var(--anchor-${index + 1})` }} />
              <span title={work.title ?? 'Untitled'}>
                {short(work.title ?? 'Untitled', 50)} and works near it
              </span>
            </span>
          ))}
          {many && (
            <span>
              <i className="swatch shared" /> Near several anchors
            </span>
          )}
          <span>
            <i className="swatch unlinked" /> Not linked to {many ? 'an anchor' : 'the anchor'}
          </span>
        </>
      )}
      {scheme === 'relation' && (
        <>
          <span>
            <i className="swatch anchor" /> {many ? 'Anchors' : 'Anchor'}
          </span>
          <span>
            <i className="swatch citing" /> Citing works
          </span>
          <span>
            <i className="swatch cited" /> Cited works
          </span>
        </>
      )}
      {scheme === 'field' && (
        <>
          {fields.map(({ slot, name, count }) => (
            <span key={name} className="legend-anchor">
              <i className="swatch field" style={{ '--swatch': `var(--node-field-${slot + 1})` }} />
              <span title={name}>{short(name, 50)}</span>
              <span className="muted legend-count">{count}</span>
            </span>
          ))}
          {otherFields > 0 && (
            <span>
              <i className="swatch unlinked" /> Other {level.plural}{' '}
              <span className="muted">{otherFields}</span>
            </span>
          )}
          {noTopic > 0 && (
            <span>
              <i className="swatch reference-only" /> No topic on OpenAlex{' '}
              <span className="muted">{noTopic}</span>
            </span>
          )}
          {fields.length === 0 && noTopic === 0 && (
            <span className="muted small">No topics yet.</span>
          )}
        </>
      )}

      <span>
        <i className="swatch expanded" /> Expanded
      </span>
      {coCited && (
        <span>
          <i className="swatch co-cited" /> Co-cited with {many ? 'an anchor' : 'the anchor'}
        </span>
      )}
      <span>
        <i className="swatch pinned">
          <Pin aria-hidden="true" />
        </i>{' '}
        Pinned: always shown
      </span>
      <span>
        <i className="swatch noted">
          <NotebookPen aria-hidden="true" />
        </i>{' '}
        Has a note
      </span>
      {READING_STATUSES.filter(({ value }) => statuses.has(value)).map(({ value, label }) => (
        <span key={value}>
          <i className="swatch pinned">
            <ReadingStatusIcon status={value} className="" />
          </i>{' '}
          {label}
        </span>
      ))}
      {warnings && (
        <span>
          <i className="swatch warned">
            <TriangleAlert aria-hidden="true" />
          </i>{' '}
          References probably missing
        </span>
      )}
      <span className="muted small">
        Older works toward the top left, newer toward the bottom right
      </span>
      <span className="muted small">Circle size: total times cited</span>
    </section>
  );
}

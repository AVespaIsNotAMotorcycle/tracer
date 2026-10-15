import { useState } from 'react';
import { fillYears } from './citationYears.js';

// Chart geometry, in SVG units (drawn at about one unit per pixel in the details panel).
const WIDTH = 300;
const TOP = 14; // Room for the maximum's label.
const PLOT = 64;
const AXIS = 16; // Room for the year labels.
const HEIGHT = TOP + PLOT + AXIS;
const GAP = 2; // Surface between adjacent columns.
const MAX_BAR = 24;
const RADIUS = 4; // Rounded data end; square at the baseline.

/** A column from the baseline up, its top corners rounded. */
function columnPath(x, y, width, height) {
  const r = Math.min(RADIUS, width / 2, height);
  const bottom = y + height;
  return `M${x},${bottom}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${
    x + width
  },${y + r}V${bottom}Z`;
}

/**
 * Where the tooltip goes for a column at `fraction` of the chart's width: centered over it,
 * or held to the chart's edge near either end, so it never runs out of the panel.
 */
function tooltipPosition(fraction) {
  if (fraction < 0.2) return { left: 0 };
  if (fraction > 0.8) return { right: 0 };
  return { left: `${fraction * 100}%`, transform: 'translateX(-50%)' };
}

const citations = (count) => `${count.toLocaleString('en')} citation${count === 1 ? '' : 's'}`;

/**
 * How often a work has been cited each year (see getCitationsByYear in api.js): a column per
 * year from its first citation to its last, a tooltip on hover or keyboard focus (arrow keys
 * move between years), and the same numbers as a table. Nothing when there are none.
 *
 * @param {{ years: { year: number, count: number }[] }} props
 */
export default function CitationsByYear({ years }) {
  const series = fillYears(years);
  const [active, setActive] = useState(null);
  if (series.length === 0) return null;

  const max = Math.max(...series.map((entry) => entry.count));
  const peak = series.find((entry) => entry.count === max);
  const slot = WIDTH / series.length;
  const bar = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const xOf = (i) => i * slot + (slot - bar) / 2;
  const heightOf = (count) => (count / max) * PLOT;
  const first = series[0].year;
  const last = series.at(-1).year;
  const summary = `Citations per year, ${first} to ${last}: most in ${peak.year} (${citations(max)}).`;
  const current = active == null ? null : series[active];

  const onKeyDown = (event) => {
    const moves = {
      ArrowLeft: (i) => Math.max(0, i - 1),
      ArrowRight: (i) => Math.min(series.length - 1, i + 1),
      Home: () => 0,
      End: () => series.length - 1,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setActive((i) => move(i ?? series.length - 1));
  };

  return (
    <section className="citations-by-year" aria-labelledby="citations-by-year-title">
      <h3 id="citations-by-year-title">Citations per year</h3>
      <div className="chart">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={summary}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <line className="chart-grid" x1={0} x2={WIDTH} y1={TOP} y2={TOP} />
          <text className="chart-label" x={0} y={TOP - 4}>
            {max.toLocaleString('en')}
          </text>
          {series.map((entry, i) =>
            entry.count > 0 ? (
              <path
                key={entry.year}
                className={i === active ? 'chart-bar active' : 'chart-bar'}
                d={columnPath(
                  xOf(i),
                  TOP + PLOT - heightOf(entry.count),
                  bar,
                  heightOf(entry.count),
                )}
              />
            ) : null,
          )}
          <line className="chart-baseline" x1={0} x2={WIDTH} y1={TOP + PLOT} y2={TOP + PLOT} />
          <text className="chart-label" x={0} y={HEIGHT - 3}>
            {first}
          </text>
          {last !== first && (
            <text className="chart-label" x={WIDTH} y={HEIGHT - 3} textAnchor="end">
              {last}
            </text>
          )}
          {/* Hit areas: each year's whole column, so short bars are easy to point at. */}
          {series.map((entry, i) => (
            <rect
              key={entry.year}
              className="chart-hit"
              x={i * slot}
              y={0}
              width={slot}
              height={TOP + PLOT}
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </svg>
        {current && (
          <div
            className="chart-tooltip"
            role="status"
            style={tooltipPosition((xOf(active) + bar / 2) / WIDTH)}
          >
            <strong>{citations(current.count)}</strong> <span>{current.year}</span>
          </div>
        )}
      </div>
      <p className="muted small">Works on OpenAlex citing it, by the year they were published.</p>
      <details className="chart-table">
        <summary>Show as a table</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Year</th>
              <th scope="col">Citations</th>
            </tr>
          </thead>
          <tbody>
            {years.map(({ year, count }) => (
              <tr key={year}>
                <td>{year}</td>
                <td>{count.toLocaleString('en')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

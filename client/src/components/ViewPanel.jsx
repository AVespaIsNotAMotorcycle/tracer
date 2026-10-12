import { DEFAULT_AXIS_ANGLE, MAX_AXIS_ANGLE, MIN_AXIS_ANGLE } from '../graph/axis.js';

/** View settings that change how the graph is drawn, not what it contains. */
export default function ViewPanel({ axisAngle, onAxisAngleChange }) {
  return (
    <section className="panel" aria-labelledby="view-heading">
      <h2 id="view-heading">View</h2>
      <label className="filter-range">
        Time axis angle: {axisAngle}°
        <input
          type="range"
          min={MIN_AXIS_ANGLE}
          max={MAX_AXIS_ANGLE}
          step={5}
          value={axisAngle}
          onChange={(event) => onAxisAngleChange(Number(event.target.value))}
        />
      </label>
      <div className="filter-footer">
        <span className="muted">0° horizontal, 90° vertical</span>
        <button
          type="button"
          className="link-button"
          onClick={() => onAxisAngleChange(DEFAULT_AXIS_ANGLE)}
          disabled={axisAngle === DEFAULT_AXIS_ANGLE}
          aria-label="Reset angle"
        >
          Reset
        </button>
      </div>
    </section>
  );
}

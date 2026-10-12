import { formatEta } from '../graph/progress.js';

/**
 * One entry per running task (build, re-anchor, each expansion): requests done out of the
 * known-or-estimated total, works found, and time remaining. "~" marks estimates.
 */
export default function LoadingProgress({ tasks }) {
  if (tasks.length === 0) return null;
  return (
    <ul className="loading-progress" aria-label="Loading progress">
      {tasks.map((task) => (
        <li key={task.key}>
          <div className="loading-head">
            <span className="loading-label">{task.label}</span>
            <span className="muted">{formatEta(task.etaMs)}</span>
          </div>
          <progress
            max={Math.max(task.total, 1)}
            value={task.done}
            aria-label={`${task.label}: ${task.done} of ${task.total} requests`}
          />
          <div className="muted small">
            {task.done} of {task.estimated ? '~' : ''}
            {task.total} requests · {task.works} works
            {task.expectedWorks != null && task.expectedWorks > task.works
              ? ` (~${task.expectedWorks} expected)`
              : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

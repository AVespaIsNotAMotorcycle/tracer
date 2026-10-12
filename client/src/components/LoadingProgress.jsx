import { formatEta } from '../graph/progress.js';

// Queued requests listed per task before collapsing the rest into "and N more".
const QUEUED_SHOWN = 5;

/**
 * One entry per running task (build, re-anchor, each expansion): requests done out of the
 * known-or-estimated total, works found, and time remaining. "~" marks estimates. Below that,
 * the requests in progress and the first few queued.
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
          <RequestList task={task} />
        </li>
      ))}
    </ul>
  );
}

/** Which requests a task is running and which are waiting. */
function RequestList({ task }) {
  const running = task.running ?? [];
  const queued = task.queued ?? [];
  if (running.length === 0 && queued.length === 0) return null;
  const more = queued.length - QUEUED_SHOWN;
  return (
    <div className="loading-requests small">
      {running.length > 0 && (
        <>
          <h3>In progress</h3>
          <ul aria-label={`${task.label}: in progress`}>
            {running.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ul>
        </>
      )}
      {queued.length > 0 && (
        <>
          <h3>Queued</h3>
          <ul aria-label={`${task.label}: queued`}>
            {queued.slice(0, QUEUED_SHOWN).map((label, i) => (
              <li key={i}>{label}</li>
            ))}
            {more > 0 && <li className="muted">and {more} more</li>}
          </ul>
        </>
      )}
    </div>
  );
}

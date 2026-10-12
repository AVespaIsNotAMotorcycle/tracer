import { sourceType } from '../graph/sourceTypes.js';

/** The source types present on the graph, with their node icons and counts, most common first. */
export default function SourceTypeLegend({ works }) {
  const counts = new Map();
  for (const work of works.values()) {
    const { key } = sourceType(work.type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return (
    <section className="panel" aria-labelledby="source-types-heading">
      <h2 id="source-types-heading">Source types</h2>
      <ul className="source-types">
        {rows.map(([key, count]) => {
          const { label, Icon } = sourceType(key);
          return (
            <li key={key}>
              <Icon className="icon" aria-hidden="true" />
              <span>{label}</span>
              <span className="muted">{count}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

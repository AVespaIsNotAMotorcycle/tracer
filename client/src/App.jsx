import { useMemo, useState } from 'react';
import './App.css';
import DetailsPanel from './components/DetailsPanel.jsx';
import FiltersPanel from './components/FiltersPanel.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import GraphView from './graph/GraphView.jsx';
import { deriveEdges, inGraphCitationCounts, NO_FILTERS, visibleIds } from './graph/graphModel.js';
import { useCitationGraph } from './graph/useCitationGraph.js';

// Conservative defaults: each level multiplies requests, and the keyless OpenAlex budget is
// small.
const DEFAULT_OPTIONS = { citingDepth: 1, citedDepth: 1, limit: 20, maxNodes: 300 };

const EMPTY_SET = new Set();

export default function App() {
  const { graph, status, error, truncated, expanding, build, expand } = useCitationGraph();
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [selectedId, setSelectedId] = useState(null);

  const counts = useMemo(() => inGraphCitationCounts(graph.works), [graph.works]);
  const outgoing = useMemo(() => {
    const result = new Map();
    for (const { source } of deriveEdges(graph.works))
      result.set(source, (result.get(source) ?? 0) + 1);
    return result;
  }, [graph.works]);
  const visible = useMemo(
    () => visibleIds(graph, filters, counts, selectedId ? [selectedId] : []),
    [graph, filters, counts, selectedId],
  );
  const maxCount = useMemo(() => Math.max(0, ...counts.values()), [counts]);

  const handleBuild = (rootId) => {
    setSelectedId(null);
    setFilters(NO_FILTERS);
    build(rootId, options);
  };

  const selected = selectedId ? graph.works.get(selectedId) : null;
  const hasGraph = graph.works.size > 0;

  return (
    <div className={`app${selected ? ' has-details' : ''}`}>
      <header className="app-header">
        <h1>Tracer</h1>
        <p className="muted">Citation graphs for the humanities</p>
      </header>

      <aside className="sidebar">
        <SearchPanel
          options={options}
          onOptionsChange={setOptions}
          onBuild={handleBuild}
          busy={status === 'loading'}
        />
        {hasGraph && (
          <FiltersPanel
            filters={filters}
            onChange={setFilters}
            maxCount={maxCount}
            visibleCount={visible.size}
            totalCount={graph.works.size}
          />
        )}
        {hasGraph && (
          <section className="panel legend" aria-label="Legend">
            <span>
              <i className="swatch root" /> Starting work
            </span>
            <span>
              <i className="swatch citing" /> Citing works
            </span>
            <span>
              <i className="swatch cited" /> Cited works
            </span>
            <span className="muted small">Circle size: times cited by works on this graph</span>
          </section>
        )}
      </aside>

      <main className="canvas">
        <div className="status" role="status">
          {status === 'loading' && `Building graph… ${graph.works.size} works`}
          {status === 'done' &&
            truncated &&
            `Stopped at ${graph.works.size} works (max works limit). Expand nodes to add more.`}
        </div>
        {error && (
          <p role="alert" className="error canvas-error">
            {error}
          </p>
        )}
        {hasGraph ? (
          <GraphView
            graph={graph}
            counts={counts}
            visible={visible}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : (
          status !== 'loading' && (
            <div className="empty">
              <p>Search for a work, or paste a DOI, to map what it cites and what cites it.</p>
            </div>
          )
        )}
      </main>

      {selected && (
        <DetailsPanel
          work={selected}
          relation={graph.relations.get(selected.id)}
          citedByOnGraph={counts.get(selected.id) ?? 0}
          citesOnGraph={outgoing.get(selected.id) ?? 0}
          expanded={graph.expanded.get(selected.id) ?? EMPTY_SET}
          expanding={expanding.has(selected.id)}
          onExpand={() => expand(selected.id, { limit: options.limit })}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

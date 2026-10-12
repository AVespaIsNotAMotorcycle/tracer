import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import DetailsPanel from './components/DetailsPanel.jsx';
import FiltersPanel from './components/FiltersPanel.jsx';
import LoadingProgress from './components/LoadingProgress.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import ViewPanel from './components/ViewPanel.jsx';
import { DEFAULT_AXIS_ANGLE } from './graph/axis.js';
import GraphView from './graph/GraphView.jsx';
import {
  deriveEdges,
  inGraphCitationCounts,
  layoutYears,
  NO_FILTERS,
  visibleIds,
} from './graph/graphModel.js';
import { useCitationGraph } from './graph/useCitationGraph.js';
import { readUrlState, writeUrlState } from './urlState.js';

const EMPTY_SET = new Set();

export default function App() {
  const { graph, status, tasks, error, truncated, expanding, build, reanchor, expand, reset } =
    useCitationGraph();
  const busy = status === 'loading' || status === 'reanchoring';
  // Build options start from the URL (or the defaults), so a shared link reproduces the graph.
  const [options, setOptions] = useState(() => readUrlState(window.location.search).options);
  const [filters, setFilters] = useState(NO_FILTERS);
  const [selectedId, setSelectedId] = useState(null);
  const [axisAngle, setAxisAngle] = useState(DEFAULT_AXIS_ANGLE);

  const counts = useMemo(() => inGraphCitationCounts(graph.works), [graph.works]);
  const years = useMemo(() => layoutYears(graph), [graph]);
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

  // How the next completed build or re-anchor updates the URL: 'push' a history entry when the
  // user started it (so Back returns to the previous anchor), 'replace' when it came from the
  // URL itself (page load, Back/Forward), so history isn't duplicated. `options` are the ones
  // that build used, not whatever the form shows by the time it finishes.
  const pendingUrl = useRef(null);

  const handleBuild = (anchorId) => {
    setSelectedId(null);
    setFilters(NO_FILTERS);
    pendingUrl.current = { mode: 'push', options };
    build(anchorId, options);
  };

  const handleReanchor = (anchorId) => {
    pendingUrl.current = { mode: 'push', options };
    reanchor(anchorId, options);
  };

  // Open the graph a shared URL points to.
  useEffect(() => {
    const { anchor, options: urlOptions } = readUrlState(window.location.search);
    if (!anchor) return;
    pendingUrl.current = { mode: 'replace', options: urlOptions };
    build(anchor, urlOptions);
  }, [build]);

  // Back/Forward: rebuild whatever graph the URL now describes.
  useEffect(() => {
    const handlePopState = () => {
      const { anchor, options: urlOptions } = readUrlState(window.location.search);
      setOptions(urlOptions);
      setSelectedId(null);
      setFilters(NO_FILTERS);
      if (anchor) {
        pendingUrl.current = { mode: 'replace', options: urlOptions };
        build(anchor, urlOptions);
      } else {
        pendingUrl.current = null;
        reset();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [build, reset]);

  // Once a build or re-anchor finishes, write its anchor and options to the URL. A failed build
  // leaves the URL alone; a failed re-anchor keeps the old anchor, which the URL already shows.
  useEffect(() => {
    const pending = pendingUrl.current;
    // Wait for the run to finish. 'idle' means it hasn't started yet: on page load this effect
    // runs in the same pass that starts the build, before its status changes.
    if (!pending || busy || status === 'idle') return;
    pendingUrl.current = null;
    const anchorWork = graph.works.get(graph.anchorId);
    if (status !== 'done' || !anchorWork) return;
    const { pathname, search, hash } = window.location;
    const next = writeUrlState(search, anchorWork, pending.options);
    if (next === search) return;
    const url = `${pathname}${next}${hash}`;
    if (pending.mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [busy, status, graph]);

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
          busy={busy}
        />
        {hasGraph && (
          <FiltersPanel
            filters={filters}
            onChange={setFilters}
            works={graph.works}
            maxCount={maxCount}
            visibleCount={visible.size}
            totalCount={graph.works.size}
          />
        )}
        {hasGraph && <ViewPanel axisAngle={axisAngle} onAxisAngleChange={setAxisAngle} />}
        {hasGraph && (
          <section className="panel legend" aria-label="Legend">
            <span>
              <i className="swatch anchor" /> Anchor
            </span>
            <span>
              <i className="swatch citing" /> Citing works
            </span>
            <span>
              <i className="swatch cited" /> Cited works
            </span>
            <span className="muted small">
              Older works toward the top left, newer toward the bottom right
            </span>
            <span className="muted small">Circle size: times cited by works on this graph</span>
          </section>
        )}
      </aside>

      <main className="canvas">
        <div className="canvas-overlay">
          <LoadingProgress tasks={tasks} />
          {/* Announced to screen readers only on start/finish, not every request. While a
              progress card shows the same thing visually, it's hidden from sight. */}
          <div className={tasks.length > 0 ? 'visually-hidden' : 'status'} role="status">
            {tasks.length > 0
              ? `${tasks[0].label}…`
              : status === 'done' && truncated
                ? `Stopped at ${graph.works.size} works (max works limit). Expand nodes to add more.`
                : ''}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
        {hasGraph ? (
          <GraphView
            graph={graph}
            counts={counts}
            years={years}
            visible={visible}
            selectedId={selectedId}
            onSelect={setSelectedId}
            building={busy}
            axisAngle={axisAngle}
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
          busy={busy}
          onExpand={() => expand(selected.id, { limit: options.limit })}
          onMakeAnchor={() => handleReanchor(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

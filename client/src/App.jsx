import { Pin, NotebookPen } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSavedGraph, saveGraph, saveGraphSnapshot, updateGraph } from './api.js';
import './App.css';
import { useAuth } from './auth/useAuth.js';
import AdvancedSearch from './components/AdvancedSearch.jsx';
import DetailsPanel from './components/DetailsPanel.jsx';
import FiltersPanel from './components/FiltersPanel.jsx';
import Header from './components/Header.jsx';
import LoadingProgress from './components/LoadingProgress.jsx';
import ProfilePage from './components/ProfilePage.jsx';
import SaveGraph from './components/SaveGraph.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import ViewPanel from './components/ViewPanel.jsx';
import { DEFAULT_AXIS_ANGLE } from './graph/axis.js';
import GraphView from './graph/GraphView.jsx';
import {
  canExpand,
  deriveEdges,
  CO_CITATION_LIMIT,
  coCiters,
  defaultMinCoCiters,
  foldBookParts,
  graphSnapshot,
  inGraphCitationCounts,
  inGraphConnectionCounts,
  totalCitationCounts,
  layoutYears,
  NO_FILTERS,
  visibleIds,
} from './graph/graphModel.js';
import { connectedComponents } from './graph/lanes.js';
import { useCitationGraph } from './graph/useCitationGraph.js';
import { readUrlState, shareableId, withSavedGraph, writeUrlState } from './urlState.js';

const EMPTY_SET = new Set();

/** Directions fetched for every one of `ids` (a book and its chapters count as one node). */
function expandedDirections(graph, ids) {
  const sets = ids.map((id) => graph.expanded.get(id) ?? EMPTY_SET);
  if (sets.length === 1) return sets[0];
  return new Set(['citing', 'cited'].filter((d) => sets.every((set) => set.has(d))));
}

const sameOptions = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);

/** How many works on the graph each work cites. */
function outgoingCounts(works) {
  const result = new Map();
  for (const { source } of deriveEdges(works)) result.set(source, (result.get(source) ?? 0) + 1);
  return result;
}

/** Notes on works from a saved graph's annotations, as Tracer ID → text. */
const notesFrom = (annotations = []) =>
  new Map(
    annotations
      .filter((a) => a.kind === 'note' && a.target?.type === 'work' && a.body)
      .map((a) => [a.target.workId, a.body]),
  );

// Auto-save is remembered per saved graph in this browser, so reloading one keeps it on.
const autoSaveKey = (id) => `tracer:autoSave:${id}`;
function rememberAutoSave(id, on) {
  try {
    if (on) window.localStorage.setItem(autoSaveKey(id), '1');
    else window.localStorage.removeItem(autoSaveKey(id));
  } catch {
    // Storage blocked: it just won't be remembered.
  }
}
function autoSaveRemembered(id) {
  try {
    return window.localStorage.getItem(autoSaveKey(id)) === '1';
  } catch {
    return false;
  }
}

// How long changes settle before auto-save sends them, so a burst (say, stepping a slider) is
// one save.
export const AUTO_SAVE_DELAY_MS = 1500;

const short = (text, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The app: the graph, or the signed-in user's saved graphs at /profile. There's no client-side
 * router; links between the two load the page, and the server serves index.html for both.
 */
export default function App() {
  const auth = useAuth();
  if (window.location.pathname === '/profile') return <ProfilePage auth={auth} />;
  return <GraphPage auth={auth} />;
}

function GraphPage({ auth }) {
  const {
    graph,
    status,
    tasks,
    error,
    truncated,
    expanding,
    build,
    restore,
    reanchor,
    expand,
    collapse,
    addWorks,
    findCoCitations,
    applyCoCitations,
    findPath,
    reset,
  } = useCitationGraph();
  const busy = status === 'loading' || status === 'reanchoring';
  // Build options start from the URL (or the defaults), so a shared link reproduces the graph.
  const [options, setOptions] = useState(() => readUrlState(window.location.search).options);
  const [filters, setFilters] = useState(NO_FILTERS);
  // Works the user pinned: always shown, whatever the filters. View state like the filters,
  // kept across re-anchoring and saved with the graph.
  const [pinned, setPinned] = useState(() => new Set());
  const togglePin = (id) =>
    setPinned((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // The user's notes on works (Tracer ID → text). Like pins, kept across re-anchoring and saved
  // with the graph (as annotations), including notes on works a rebuild has since dropped, so
  // they're back if the work is.
  const [notes, setNotes] = useState(() => new Map());
  const setNote = (id, text) =>
    setNotes((prev) => {
      const next = new Map(prev);
      if (text) next.set(id, text);
      else next.delete(id);
      return next;
    });
  // The last co-citation search, for one anchor: { anchorId, found, counts, citers } (counts:
  // how many works citing the anchor cite each, from 2 up). Works at or above the minimum
  // are highlighted while that's still the anchor.
  const [coCitations, setCoCitations] = useState(null);
  const [findingCoCitations, setFindingCoCitations] = useState(false);
  // The minimum citers the user chose for a co-citation, for one anchor ({ anchorId, value });
  // otherwise it's defaultMinCoCiters.
  const [minCoCitersChoice, setMinCoCitersChoice] = useState(null);
  // The last path search from a work to the anchor: { anchorId, fromId, result } (see
  // findPathToAnchor), and the work being searched from, if one is.
  const [pathSearch, setPathSearch] = useState(null);
  const [findingPathFrom, setFindingPathFrom] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [axisAngle, setAxisAngle] = useState(DEFAULT_AXIS_ANGLE);
  // Counts runs (builds, re-anchors, options changes), so the view re-fits after each one.
  const [runCount, setRunCount] = useState(0);
  // The options the current graph was built with, once a run finishes.
  const [graphOptions, setGraphOptions] = useState(null);
  // The saved graph this one was opened from or last saved as ({ id, name }), so saving again
  // can update it. A new search starts a new, unsaved graph.
  const [savedGraph, setSavedGraph] = useState(null);
  // Whether every change to the saved graph is saved as it happens, and how that's going:
  // { state: 'saving' | 'saved' | 'error', message? }.
  const [autoSave, setAutoSave] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState(null);
  // What was last saved (or opened): the state's JSON and the graph it was built into, so
  // auto-save knows whether anything changed and whether to send a new snapshot. `baseline`
  // asks for the next idle graph to be taken as saved, after opening one.
  const lastSaved = useRef({ json: null, graph: null, baseline: false });
  const saving = useRef(false);
  const [openError, setOpenError] = useState(null);
  // Advanced search fills the page below the header while open. Once opened it stays mounted
  // (hidden), so its fields, results and chosen works are still there next time; `query` is
  // the simple search's text when it was first opened, to start from.
  const [advanced, setAdvanced] = useState({ mounted: false, open: false, query: '' });
  const openAdvanced = (query) =>
    setAdvanced((prev) =>
      prev.mounted ? { ...prev, open: true } : { mounted: true, open: true, query },
    );
  const closeAdvanced = useCallback(() => setAdvanced((prev) => ({ ...prev, open: false })), []);

  // What the graph shows: each book's chapters folded into the book (see foldBookParts).
  // Everything drawn or filtered works from this view; `graph` keeps every work.
  const { graph: view, partsOf, bookOf } = useMemo(() => foldBookParts(graph), [graph]);
  // A selected chapter whose book has since arrived is shown as the book.
  const shownId = selectedId ? (bookOf.get(selectedId) ?? selectedId) : null;
  const counts = useMemo(() => inGraphCitationCounts(view.works), [view.works]);
  const connections = useMemo(() => inGraphConnectionCounts(view.works), [view.works]);
  const sizes = useMemo(() => totalCitationCounts(view.works, partsOf), [view.works, partsOf]);
  const years = useMemo(() => layoutYears(view), [view]);
  const outgoing = useMemo(() => outgoingCounts(view.works), [view.works]);
  const visible = useMemo(
    () => visibleIds(view, filters, connections, [...pinned, ...(shownId ? [shownId] : [])], years),
    [view, filters, connections, pinned, shownId, years],
  );
  // Per-chapter counts for a book's details, from the unfolded graph.
  const partCounts = useMemo(
    () => (partsOf.size ? inGraphCitationCounts(graph.works) : null),
    [graph.works, partsOf],
  );
  const partOutgoing = useMemo(
    () => (partsOf.size ? outgoingCounts(graph.works) : null),
    [graph.works, partsOf],
  );
  // The links slider's upper end: the most links of any work but the anchor, which is always
  // shown and linked to nearly everything, so counting it would leave most of the range empty.
  const maxConnections = useMemo(
    () => Math.max(1, ...[...connections].filter(([id]) => id !== view.anchorId).map(([, n]) => n)),
    [connections, view.anchorId],
  );

  // How the next completed build or re-anchor updates the URL: 'push' a history entry when the
  // user started it (so Back returns to the previous anchor), 'replace' when it came from the
  // URL itself (page load, Back/Forward), so history isn't duplicated. `options` are the ones
  // that build used, not whatever the form shows by the time it finishes.
  const pendingUrl = useRef(null);

  // Builds a new graph around `anchorId`. Any `extraIds` (works chosen together in advanced
  // search) are then added and expanded, as if the user had expanded each, and pinned: the user
  // asked for them, so filters (such as minimum links, for a work nothing cites) don't hide them.
  const handleBuild = (anchorId, extraIds = []) => {
    setSelectedId(null);
    setFilters(NO_FILTERS);
    setPinned(new Set(extraIds));
    setNotes(new Map());
    setCoCitations(null);
    setPathSearch(null);
    setSavedGraph(null);
    setAutoSave(false);
    setAutoSaveStatus(null);
    setOpenError(null);
    pendingUrl.current = { mode: 'push', options };
    setRunCount((n) => n + 1);
    if (extraIds.length) {
      restore({ anchorId, options, expanded: extraIds }, 'Building graph');
    } else {
      build(anchorId, options);
    }
  };

  // Adds works chosen in advanced search to the graph on screen, expanding and pinning each.
  const handleAddWorks = (ids) => {
    setPinned((prev) => new Set([...prev, ...ids]));
    setRunCount((n) => n + 1);
    addWorks(ids, options);
  };

  // Rebuild the current graph with the form's options: a re-anchor on the same anchor, so works
  // the user expanded (and earlier anchors) stay.
  const handleApplyOptions = () => handleReanchor(graph.anchorId);

  const handleReanchor = (anchorId) => {
    pendingUrl.current = { mode: 'push', options };
    setRunCount((n) => n + 1);
    reanchor(anchorId, options);
  };

  // Opens a saved graph: its options, filters and view, then the graph itself. That's the
  // server's snapshot of it as last built, while it's fresh (a week); otherwise it's rebuilt
  // with the works the user had expanded (see restoreGraph), and the result becomes the new
  // snapshot. The URL already names it (?graph=<id>).
  const openSaved = useCallback(
    (saved) => {
      setOptions(saved.options);
      setGraphOptions(saved.options);
      setFilters({
        ...NO_FILTERS,
        ...saved.filters,
        excludedTypes: saved.filters?.excludedTypes ?? [],
      });
      setAxisAngle(saved.view?.axisAngle ?? DEFAULT_AXIS_ANGLE);
      setPinned(new Set(saved.view?.pinned ?? []));
      setNotes(notesFrom(saved.annotations));
      setCoCitations(null);
      setPathSearch(null);
      setSelectedId(null);
      setSavedGraph({ id: saved.id, name: saved.name });
      setAutoSave(autoSaveRemembered(saved.id));
      setAutoSaveStatus(null);
      lastSaved.current = { json: null, graph: null, baseline: true };
      setOpenError(null);
      setRunCount((n) => n + 1);
      restore(
        {
          anchorId: saved.anchor.id,
          options: saved.options,
          expanded: saved.expanded ?? [],
          snapshot: saved.snapshot,
        },
        `Opening “${short(saved.name)}”`,
      ).then((built) => {
        if (!built || !saved.stateKey) return;
        // Only saves time next time, so a failure isn't worth reporting.
        saveGraphSnapshot(
          saved.id,
          saved.stateKey,
          graphSnapshot(built.graph, built.truncated),
        ).catch(() => {});
      });
    },
    [restore],
  );
  const openSavedById = useCallback(
    (id) =>
      getSavedGraph(id)
        .then(openSaved)
        .catch((err) => setOpenError(`Couldn’t open the saved graph: ${err.message}`)),
    [openSaved],
  );

  // Open the graph a shared URL (or a saved graph's link) points to.
  useEffect(() => {
    const { anchor, options: urlOptions, graph: savedId } = readUrlState(window.location.search);
    if (savedId) {
      openSavedById(savedId);
      return;
    }
    if (!anchor) return;
    // The first run needs no new fit key: nothing has been fitted yet.
    pendingUrl.current = { mode: 'replace', options: urlOptions };
    build(anchor, urlOptions);
  }, [build, openSavedById]);

  // Back/Forward: rebuild whatever graph the URL now describes.
  useEffect(() => {
    const handlePopState = () => {
      const { anchor, options: urlOptions, graph: savedId } = readUrlState(window.location.search);
      if (savedId) {
        pendingUrl.current = null;
        openSavedById(savedId);
        return;
      }
      setOptions(urlOptions);
      setSelectedId(null);
      setFilters(NO_FILTERS);
      setPinned(new Set());
      setNotes(new Map());
      setCoCitations(null);
      setSavedGraph(null);
      setAutoSave(false);
      setAutoSaveStatus(null);
      if (anchor) {
        pendingUrl.current = { mode: 'replace', options: urlOptions };
        setRunCount((n) => n + 1);
        build(anchor, urlOptions);
      } else {
        pendingUrl.current = null;
        reset();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [build, reset, openSavedById]);

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
    setGraphOptions(pending.options);
    const { pathname, search, hash } = window.location;
    const next = writeUrlState(search, anchorWork, pending.options);
    if (next === search) return;
    const url = `${pathname}${next}${hash}`;
    if (pending.mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  }, [busy, status, graph]);

  // Works whose citing and cited works have both been fetched (for a book, its chapters' too),
  // as the details panel's "Expanded" button shows. The graph rings them.
  const expandedIds = useMemo(() => {
    const ids = new Set();
    for (const id of view.works.keys()) {
      const parts = (partsOf.get(id) ?? []).map((part) => part.id);
      const done = expandedDirections(graph, [id, ...parts]);
      if (done.has('citing') && done.has('cited')) ids.add(id);
    }
    return ids;
  }, [view.works, graph, partsOf]);

  // The anchor and its chapters, and how many works on the graph cite them: the works whose
  // reference lists are searched for co-citations.
  const anchorTargets = useMemo(
    () => [graph.anchorId, ...(partsOf.get(graph.anchorId) ?? []).map((part) => part.id)],
    [graph.anchorId, partsOf],
  );
  const citerCount = useMemo(() => coCiters(graph, anchorTargets).length, [graph, anchorTargets]);
  const maxCoCiters = Math.max(2, citerCount);
  const minCoCiters = Math.min(
    maxCoCiters,
    minCoCitersChoice?.anchorId === graph.anchorId
      ? minCoCitersChoice.value
      : defaultMinCoCiters(citerCount),
  );

  // Co-cited works as shown (a chapter as its book), with how many works citing the anchor
  // cite each; empty unless they were found for the current anchor.
  const coCited = useMemo(() => {
    const shown = new Map();
    if (coCitations?.anchorId !== graph.anchorId) return shown;
    for (const [id, count] of coCitations.counts) {
      if (count < minCoCiters) continue;
      const viewId = bookOf.get(id) ?? id;
      if (view.works.has(viewId)) shown.set(viewId, Math.max(count, shown.get(viewId) ?? 0));
    }
    return shown;
  }, [coCitations, graph.anchorId, minCoCiters, bookOf, view.works]);

  // Looks through the reference lists of the works on the graph citing the anchor (or its
  // chapters), adding works at least minCoCiters of them cite, and highlights them.
  const handleFindCoCitations = async () => {
    const anchorId = graph.anchorId;
    const minCiters = minCoCiters;
    setFindingCoCitations(true);
    const result = await findCoCitations(anchorTargets, {
      limit: CO_CITATION_LIMIT,
      maxNodes: (graphOptions ?? options).maxNodes,
      minCiters,
      keep: pinned,
    });
    setFindingCoCitations(false);
    if (!result) return;
    setCoCitations({ anchorId, ...result, citers: citerCount });
    // Fixed from here on, so the default following the number of citers (which expanding can
    // change) doesn't move the minimum out of step with what was added.
    setMinCoCitersChoice({ anchorId, value: minCiters });
  };

  // A new minimum. After a search, it applies at once: added works that no longer qualify are
  // removed, and ones that now do are added, from the search's results.
  const handleMinCoCitersChange = (value) => {
    const next = Math.max(2, Math.min(maxCoCiters, value));
    setMinCoCitersChoice({ anchorId: graph.anchorId, value: next });
    if (coCitations?.anchorId === graph.anchorId) {
      applyCoCitations(coCitations, {
        minCiters: next,
        maxNodes: (graphOptions ?? options).maxNodes,
        keep: pinned,
      });
    }
  };

  // Works joined to the anchor by citations on the graph, either way. Others (brought in by
  // expanding or adding a work) can look for a path to it.
  const anchorComponent = useMemo(
    () =>
      new Set(connectedComponents(view.works.keys(), deriveEdges(view.works), view.anchorId)[0]),
    [view],
  );

  const handleFindPath = async (fromId) => {
    const anchorId = graph.anchorId;
    setFindingPathFrom(fromId);
    const result = await findPath(fromId);
    setFindingPathFrom(null);
    if (result) setPathSearch({ anchorId, fromId, result });
  };

  const selected = shownId ? view.works.get(shownId) : null;
  const shownPath =
    selected && pathSearch?.fromId === selected.id && pathSearch.anchorId === graph.anchorId
      ? pathSearch.result
      : null;
  const disconnected = Boolean(
    selected && !anchorComponent.has(selected.id) && canExpand(selected),
  );
  const parts = selected
    ? (partsOf.get(selected.id) ?? []).map((work) => ({
        work,
        citedByOnGraph: partCounts.get(work.id) ?? 0,
        citesOnGraph: partOutgoing.get(work.id) ?? 0,
      }))
    : [];
  const hasGraph = graph.works.size > 0;
  const anchorWork = graph.works.get(graph.anchorId);

  // What saving stores: what's needed to rebuild the graph (anchor, the options it was built
  // with, the works the user expanded, in order), how it's shown (filters, axis, pins) and the
  // user's notes.
  const saveState = useMemo(
    () => ({
      anchor: {
        id: graph.anchorId,
        ref: anchorWork ? shareableId(anchorWork) : null,
        title: anchorWork?.title ?? null,
      },
      options: graphOptions ?? options,
      filters,
      // Pins of works no longer on the graph (dropped by a re-anchor) aren't worth keeping.
      view: { axisAngle, pinned: [...pinned].filter((id) => view.works.has(id)) },
      expanded: [...graph.sticky],
      annotations: [...notes].map(([workId, body]) => ({
        target: { type: 'work', workId },
        kind: 'note',
        body,
      })),
    }),
    [graph, anchorWork, graphOptions, options, filters, axisAngle, pinned, view, notes],
  );
  const saveJson = useMemo(() => JSON.stringify(saveState), [saveState]);
  const idle = !busy && expanding.size === 0;

  // Saves the graph as it is now, with a snapshot of its works so reopening it needn't fetch
  // them (not while a run or expansion is still changing them; and when auto-saving, only if
  // the works changed, since the server keeps the last one). Updates the saved graph it came
  // from, unless saving as new.
  const saveNow = async (name, asNew, { auto = false } = {}) => {
    const withSnapshot = idle && (!auto || lastSaved.current.graph !== graph);
    const snapshot = withSnapshot ? graphSnapshot(graph, truncated) : undefined;
    const previous = lastSaved.current;
    lastSaved.current = { json: saveJson, graph: withSnapshot ? graph : previous.graph };
    try {
      const saved =
        savedGraph && !asNew
          ? await updateGraph(savedGraph.id, name, saveState, snapshot)
          : await saveGraph(name, saveState, snapshot);
      setSavedGraph({ id: saved.id, name: saved.name });
      // Reloading (or sharing the link with yourself) reopens the saved graph.
      const { pathname, search, hash } = window.location;
      window.history.replaceState(
        null,
        '',
        `${pathname}${withSavedGraph(search, saved.id)}${hash}`,
      );
      return saved;
    } catch (err) {
      // A manual save that failed can be tried again as is.
      if (!auto) lastSaved.current = previous;
      throw err;
    }
  };

  const handleSave = async (name, asNew) => {
    const saved = await saveNow(name, asNew);
    if (autoSave) rememberAutoSave(saved.id, true);
    return saved;
  };

  // Auto-save, once the graph is idle and something has changed, after changes settle. One
  // save at a time: a change made during one is saved after it.
  useEffect(() => {
    // Just opened: once it's built, what's on screen is what was saved.
    if (lastSaved.current.baseline && idle && hasGraph) {
      lastSaved.current = { json: saveJson, graph };
    }
  }, [idle, hasGraph, saveJson, graph]);
  useEffect(() => {
    if (!autoSave || !savedGraph || !idle || !hasGraph || saving.current) return undefined;
    if (lastSaved.current.baseline) return undefined;
    if (saveJson === lastSaved.current.json && graph === lastSaved.current.graph) return undefined;
    // Not "saved" while a change waits. Kept as is if already saving, so this doesn't re-run.
    setAutoSaveStatus((prev) => (prev?.state === 'saving' ? prev : { state: 'saving' }));
    const timer = setTimeout(async () => {
      saving.current = true;
      let status;
      try {
        await saveNow(savedGraph.name, false, { auto: true });
        status = { state: 'saved' };
      } catch (err) {
        status = { state: 'error', message: err.message };
      }
      // Cleared first: the new status re-runs this effect, which saves anything changed since.
      saving.current = false;
      setAutoSaveStatus(status);
    }, AUTO_SAVE_DELAY_MS);
    return () => clearTimeout(timer);
    // saveNow reads the same state as these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSave, savedGraph, idle, hasGraph, saveJson, graph, autoSaveStatus]);

  // Turning auto-save on saves an unsaved graph at once, named after its anchor.
  const handleAutoSaveChange = async (on) => {
    setAutoSave(on);
    setAutoSaveStatus(null);
    if (savedGraph) {
      rememberAutoSave(savedGraph.id, on);
      return;
    }
    if (!on) return;
    saving.current = true;
    setAutoSaveStatus({ state: 'saving' });
    try {
      const saved = await saveNow(anchorWork?.title ?? '', false);
      rememberAutoSave(saved.id, true);
      saving.current = false;
      setAutoSaveStatus({ state: 'saved' });
    } catch (err) {
      saving.current = false;
      setAutoSave(false);
      setAutoSaveStatus({ state: 'error', message: err.message });
    }
  };

  return (
    <div className={`app${selected ? ' has-details' : ''}`}>
      <Header auth={auth} />
      {advanced.mounted && (
        <AdvancedSearch
          hidden={!advanced.open}
          initialQuery={advanced.query}
          onClose={closeAdvanced}
          onBuild={([anchorId, ...rest]) => {
            closeAdvanced();
            handleBuild(anchorId, rest);
          }}
          onAdd={(ids) => {
            closeAdvanced();
            handleAddWorks(ids);
          }}
          hasGraph={hasGraph}
          onGraph={graph.works}
          busy={busy}
        />
      )}
      <aside className="sidebar" inert={advanced.open}>
        <SearchPanel
          options={options}
          onOptionsChange={setOptions}
          onBuild={handleBuild}
          onApply={hasGraph ? handleApplyOptions : undefined}
          onAdvanced={openAdvanced}
          canApply={graphOptions != null && !sameOptions(options, graphOptions)}
          busy={busy}
        />
        {hasGraph && (
          <FiltersPanel
            filters={filters}
            onChange={setFilters}
            works={view.works}
            maxConnections={maxConnections}
            visibleCount={visible.size}
            pinnedCount={[...pinned].filter((id) => view.works.has(id)).length}
            totalCount={view.works.size}
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
            <span>
              <i className="swatch expanded" /> Expanded
            </span>
            {coCited.size > 0 && (
              <span>
                <i className="swatch co-cited" /> Co-cited with the anchor
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
            <span className="muted small">
              Older works toward the top left, newer toward the bottom right
            </span>
            <span className="muted small">Circle size: total times cited</span>
          </section>
        )}
      </aside>

      <main className="canvas" inert={advanced.open}>
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
          {(error || openError) && (
            <p role="alert" className="error">
              {error ?? openError}
            </p>
          )}
        </div>
        {hasGraph && (
          <div className="canvas-actions">
            <SaveGraph
              user={auth.user}
              savedGraph={savedGraph}
              defaultName={anchorWork?.title ?? ''}
              disabled={busy}
              onSave={handleSave}
              autoSave={autoSave}
              autoSaveStatus={autoSaveStatus}
              onAutoSaveChange={handleAutoSaveChange}
            />
          </div>
        )}
        {hasGraph ? (
          <GraphView
            graph={view}
            sizes={sizes}
            expandedIds={expandedIds}
            pinnedIds={pinned}
            notes={notes}
            coCitedIds={coCited}
            years={years}
            visible={visible}
            selectedId={shownId}
            onSelect={setSelectedId}
            building={busy}
            axisAngle={axisAngle}
            fitKey={runCount}
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
          yearInfo={years.get(selected.id)}
          citesOnGraph={outgoing.get(selected.id) ?? 0}
          parts={parts}
          expanded={expandedDirections(graph, [selected.id, ...parts.map((p) => p.work.id)])}
          expanding={expanding.has(selected.id)}
          busy={busy}
          onExpand={() =>
            expand(selected.id, {
              limit: options.limit,
              parts: parts.map((part) => part.work.id),
            })
          }
          onMakeAnchor={() => handleReanchor(selected.id)}
          pinned={pinned.has(selected.id)}
          onTogglePin={() => togglePin(selected.id)}
          note={notes.get(selected.id) ?? ''}
          onNoteChange={(text) => setNote(selected.id, text)}
          signedIn={Boolean(auth.user)}
          coCitedBy={coCited.get(selected.id) ?? null}
          onFindCoCitations={selected.id === graph.anchorId ? handleFindCoCitations : undefined}
          findingCoCitations={findingCoCitations}
          coCitationControl={
            selected.id === graph.anchorId
              ? {
                  value: minCoCiters,
                  max: maxCoCiters,
                  citers: citerCount,
                  onChange: handleMinCoCitersChange,
                }
              : null
          }
          coCitationResult={
            selected.id === graph.anchorId && coCitations?.anchorId === graph.anchorId
              ? {
                  minCiters: minCoCiters,
                  citers: coCitations.citers,
                  found: [...coCitations.counts.values()].filter((n) => n >= minCoCiters).length,
                  // Works that didn't fit under the max works setting.
                  left: [...coCitations.counts].filter(
                    ([id, n]) => n >= minCoCiters && !graph.works.has(id),
                  ).length,
                }
              : null
          }
          pathControl={
            disconnected || shownPath?.path
              ? {
                  disconnected,
                  finding: findingPathFrom === selected.id,
                  result: shownPath,
                  onFind: () => handleFindPath(selected.id),
                  onSelect: setSelectedId,
                }
              : null
          }
          onCollapse={
            // Only works the user expanded (or earlier anchors) can be collapsed; the build's
            // own expansions would just come back.
            selected.id !== graph.anchorId &&
            [selected.id, ...parts.map((part) => part.work.id)].some((id) => graph.sticky.has(id))
              ? () =>
                  collapse(
                    [selected.id, ...parts.map((part) => part.work.id)],
                    graphOptions ?? options,
                  )
              : undefined
          }
          onClose={() => setSelectedId(null)}
          inert={advanced.open}
        />
      )}
    </div>
  );
}

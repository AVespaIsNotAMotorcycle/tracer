import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSavedGraph, saveGraph, saveGraphSnapshot, updateGraph } from './api.js';
import './App.css';
import { clampOptions } from './auth/entitlements.js';
import { useAuth } from './auth/useAuth.js';
import AdvancedSearch from './components/AdvancedSearch.jsx';
import DetailsPanel from './components/DetailsPanel.jsx';
import FiltersPanel from './components/FiltersPanel.jsx';
import Legend from './components/Legend.jsx';
import LibraryPage from './components/LibraryPage.jsx';
import Header from './components/Header.jsx';
import LoadingProgress from './components/LoadingProgress.jsx';
import PricingPage from './components/PricingPage.jsx';
import ProfilePage from './components/ProfilePage.jsx';
import SaveGraph from './components/SaveGraph.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import ViewPanel from './components/ViewPanel.jsx';
import { DEFAULT_AXIS_ANGLE } from './graph/axis.js';
import {
  assignFieldColors,
  DEFAULT_FIELD_LEVEL,
  defaultColorScheme,
  fieldCounts,
  workFieldColors,
} from './graph/colorSchemes.js';
import GraphView from './graph/GraphView.jsx';
import {
  anchorNeighborhoods,
  canExpand,
  deriveEdges,
  CO_CITATION_LIMIT,
  coCiters,
  defaultMinCoCiters,
  foldBookParts,
  graphSnapshot,
  inGraphCitationCounts,
  inGraphConnectionCounts,
  isAnchor,
  totalCitationCounts,
  layoutYears,
  NO_FILTERS,
  visibleIds,
} from './graph/graphModel.js';
import { graphLinks, referenceWarnings } from './graph/provenance.js';
import { connectedComponents } from './graph/lanes.js';
import { useCitationGraph } from './graph/useCitationGraph.js';
import { statusOf } from './library/readingStatus.js';
import { useReadingStatuses } from './library/useReadingStatuses.js';
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

// Longest name a saved graph can have (as the server checks).
const MAX_NAME_LENGTH = 120;

/**
 * A graph's default name, from its anchors: one's title, two joined by "&", or the first and
 * how many more, shortened to fit a saved graph's name. The server names a graph saved without
 * a name the same way.
 */
const anchorsName = (anchors) => {
  const titles = anchors.map((work) => work.title ?? 'Untitled');
  if (titles.length <= 1) return short(titles[0] ?? '', MAX_NAME_LENGTH);
  if (titles.length === 2) return `${short(titles[0], 58)} & ${short(titles[1], 58)}`;
  return `${short(titles[0], 100)} and ${titles.length - 1} more`;
};

/**
 * The app: the graph, the signed-in user's saved graphs at /profile, or the plans at /pricing. There's no client-side
 * router; links between the two load the page, and the server serves index.html for both.
 */
export default function App() {
  const auth = useAuth();
  if (window.location.pathname === '/profile') return <ProfilePage auth={auth} />;
  if (window.location.pathname === '/pricing') return <PricingPage auth={auth} />;
  if (window.location.pathname === '/library') return <LibraryPage auth={auth} />;
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
    mergeWork,
    reset,
  } = useCitationGraph();
  const busy = status === 'loading' || status === 'reanchoring';
  // Build options start from the URL (or the defaults), so a shared link reproduces the graph.
  // What's used is kept within the plan's limits (the form can't go past them either).
  const [chosenOptions, setOptions] = useState(() => readUrlState(window.location.search).options);
  const { limits } = auth;
  const options = useMemo(() => clampOptions(chosenOptions, limits), [chosenOptions, limits]);
  // For runs started from the URL or a saved graph, which shouldn't re-run when limits arrive.
  const limitsRef = useRef(limits);
  useEffect(() => {
    limitsRef.current = limits;
  }, [limits]);
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
  // The last co-citation search, for one anchor: { anchorId, anchorsKey, found, counts, citers,
  // minCiters } (counts: how many works citing the anchor cite each, from 2 up; anchorsKey:
  // the graph's anchors then). Works at or above `minCiters` are highlighted until the anchors
  // change.
  const [coCitations, setCoCitations] = useState(null);
  const [findingCoCitations, setFindingCoCitations] = useState(false);
  // The minimum citers the user chose for a co-citation, for one anchor ({ anchorId, value });
  // otherwise it's defaultMinCoCiters.
  const [minCoCitersChoice, setMinCoCitersChoice] = useState(null);
  // The last path search from a work to anchors: { anchorsKey, fromId, targetIds, result } (see
  // findPathToAnchor), and the work being searched from, if one is.
  const [pathSearch, setPathSearch] = useState(null);
  const [findingPathFrom, setFindingPathFrom] = useState(null);
  // The anchor chosen to look for a path to, from one work: { fromId, target }.
  const [pathTarget, setPathTarget] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  // The signed-in user's reading statuses (their library, the same in every graph).
  const reading = useReadingStatuses(auth);
  // Works the server merged into another (see foldAliases) are replaced on the graph; pins,
  // notes and the selection move to the work they're now part of. Two notes on one are joined.
  // Adjusted while rendering, when the graph's aliases change, rather than in an effect.
  const aliases = graph.aliases;
  const [seenAliases, setSeenAliases] = useState(aliases);
  if (aliases !== seenAliases) {
    setSeenAliases(aliases);
    if (aliases?.size) {
      const to = (id) => aliases.get(id) ?? id;
      setPinned((prev) =>
        [...prev].some((id) => aliases.has(id)) ? new Set([...prev].map(to)) : prev,
      );
      setNotes((prev) => {
        if (![...prev.keys()].some((id) => aliases.has(id))) return prev;
        const next = new Map();
        for (const [id, text] of prev) {
          const key = to(id);
          next.set(key, next.has(key) ? `${next.get(key)}\n\n${text}` : text);
        }
        return next;
      });
      setSelectedId((prev) => (prev ? to(prev) : prev));
    }
  }
  const [axisAngle, setAxisAngle] = useState(DEFAULT_AXIS_ANGLE);
  // How nodes are colored: the user's choice of scheme ('relation', 'neighborhood' or
  // 'field'), or null for the default (by anchor with several anchors, else by relation), and
  // the level of topics the field scheme uses. View state, saved with a graph.
  const [colorSchemeChoice, setColorSchemeChoice] = useState(null);
  const [fieldLevel, setFieldLevel] = useState(DEFAULT_FIELD_LEVEL);
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
  // Each work's reading status, for its badge.
  const graphStatuses = useMemo(() => {
    const result = new Map();
    if (reading.statuses.size === 0) return result;
    for (const work of view.works.values()) {
      const status = statusOf(reading.statuses, work);
      if (status) result.set(work.id, status);
    }
    return result;
  }, [reading.statuses, view.works]);
  // Works whose reference lists are probably incomplete (see referenceWarning).
  const warnings = useMemo(() => referenceWarnings(view.works), [view.works]);
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
    () => Math.max(1, ...[...connections].filter(([id]) => !isAnchor(view, id)).map(([, n]) => n)),
    [connections, view],
  );

  // How the next completed build or re-anchor updates the URL: 'push' a history entry when the
  // user started it (so Back returns to the previous anchors), 'replace' when it came from the
  // URL itself (page load, Back/Forward), so history isn't duplicated. `options` are the ones
  // that build used, not whatever the form shows by the time it finishes.
  const pendingUrl = useRef(null);

  // Builds a new graph around `anchorIds`. Any `extraIds` (works chosen together in advanced
  // search) are then added and expanded, as if the user had expanded each, and pinned: the user
  // asked for them, so filters (such as minimum links, for a work nothing cites) don't hide them.
  const handleBuild = (anchorIds, extraIds = []) => {
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
      restore({ anchorIds, options, expanded: extraIds }, 'Building graph');
    } else {
      build(anchorIds, options);
    }
  };

  // Adds works chosen in advanced search to the graph on screen, expanding and pinning each.
  const handleAddWorks = (ids) => {
    setPinned((prev) => new Set([...prev, ...ids]));
    setRunCount((n) => n + 1);
    addWorks(ids, options);
  };

  // Rebuild the current graph with the form's options: a re-anchor on the same anchors, so
  // works the user expanded (and earlier anchors) stay.
  const handleApplyOptions = () => handleReanchor(graph.anchorIds);

  // Rebuilds around `anchorIds` (see reanchor in useCitationGraph), as a step Back can undo.
  const handleReanchor = (anchorIds, extra) => {
    pendingUrl.current = { mode: 'push', options };
    setRunCount((n) => n + 1);
    reanchor(anchorIds, options, extra);
  };
  // Another anchor beside the current ones (up to the plan's limit), or one fewer: the removed
  // anchor isn't kept as an earlier anchor would be, so its neighborhood goes.
  const anchorLimit = limits.anchors;
  const handleAddAnchor = (id) =>
    handleReanchor([...graph.anchorIds, id], { label: 'Adding an anchor' });
  const handleRemoveAnchor = (id) =>
    handleReanchor(
      graph.anchorIds.filter((other) => other !== id),
      { unstick: [id], label: 'Removing an anchor' },
    );

  // Opens a saved graph: its options, filters and view, then the graph itself. That's the
  // server's snapshot of it as last built, while it's fresh (a week); otherwise it's rebuilt
  // with the works the user had expanded (see restoreGraph), and the result becomes the new
  // snapshot. The URL already names it (?graph=<id>).
  const openSaved = useCallback(
    (found) => {
      const saved = { ...found, options: clampOptions(found.options, limitsRef.current) };
      setOptions(saved.options);
      setGraphOptions(saved.options);
      setFilters({
        ...NO_FILTERS,
        ...saved.filters,
        excludedTypes: saved.filters?.excludedTypes ?? [],
        excludedLanguages: saved.filters?.excludedLanguages ?? [],
      });
      setAxisAngle(saved.view?.axisAngle ?? DEFAULT_AXIS_ANGLE);
      setColorSchemeChoice(saved.view?.colorScheme ?? null);
      setFieldLevel(saved.view?.fieldLevel ?? DEFAULT_FIELD_LEVEL);
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
          anchorIds: saved.anchors.map((anchor) => anchor.id),
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

  // Open the graph a shared URL (or a saved graph's link) points to, once, when the account is
  // known: the plan's limits decide how many anchors and how large a build the URL can ask for.
  const accountKnown = auth.user !== undefined;
  const openedUrl = useRef(false);
  useEffect(() => {
    if (!accountKnown || openedUrl.current) return;
    openedUrl.current = true;
    const { graph: savedId, ...url } = readUrlState(window.location.search);
    if (savedId) {
      openSavedById(savedId);
      return;
    }
    const urlOptions = clampOptions(url.options, limitsRef.current);
    const anchors = url.anchors.slice(0, limitsRef.current.anchors);
    if (!anchors.length) return;
    // The first run needs no new fit key: nothing has been fitted yet.
    pendingUrl.current = { mode: 'replace', options: urlOptions };
    build(anchors, urlOptions);
  }, [accountKnown, build, openSavedById]);

  // Back/Forward: rebuild whatever graph the URL now describes.
  useEffect(() => {
    const handlePopState = () => {
      const { graph: savedId, ...url } = readUrlState(window.location.search);
      const urlOptions = clampOptions(url.options, limitsRef.current);
      const anchors = url.anchors.slice(0, limitsRef.current.anchors);
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
      if (anchors.length) {
        pendingUrl.current = { mode: 'replace', options: urlOptions };
        setRunCount((n) => n + 1);
        build(anchors, urlOptions);
      } else {
        pendingUrl.current = null;
        reset();
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [build, reset, openSavedById]);

  // Once a build or re-anchor finishes, write its anchors and options to the URL. A failed build
  // leaves the URL alone; a failed re-anchor keeps the old anchors, which the URL already shows.
  useEffect(() => {
    const pending = pendingUrl.current;
    // Wait for the run to finish. 'idle' means it hasn't started yet: on page load this effect
    // runs in the same pass that starts the build, before its status changes.
    if (!pending || busy || status === 'idle') return;
    pendingUrl.current = null;
    const anchors = graph.anchorIds.map((id) => graph.works.get(id)).filter(Boolean);
    if (status !== 'done' || !anchors.length) return;
    setGraphOptions(pending.options);
    const { pathname, search, hash } = window.location;
    const next = writeUrlState(search, anchors, pending.options);
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

  // Searches tied to the anchors (co-citations, paths) apply only while they're the same.
  const anchorsKey = graph.anchorIds.join(' ');
  // The last co-citation search, if it was made with the current anchors.
  const coSearch = coCitations?.anchorsKey === anchorsKey ? coCitations : null;
  // The anchor whose co-citation controls are shown: the selected one, else the one searched.
  const coAnchorId =
    shownId && isAnchor(graph, shownId) ? shownId : (coSearch?.anchorId ?? graph.anchorIds[0]);

  // That anchor and its chapters, and how many works on the graph cite them: the works whose
  // reference lists are searched for co-citations.
  const anchorTargets = useMemo(
    () => [coAnchorId, ...(partsOf.get(coAnchorId) ?? []).map((part) => part.id)],
    [coAnchorId, partsOf],
  );
  const citerCount = useMemo(() => coCiters(graph, anchorTargets).length, [graph, anchorTargets]);
  const maxCoCiters = Math.max(2, citerCount);
  const minCoCiters = Math.min(
    maxCoCiters,
    coSearch && coSearch.anchorId === coAnchorId
      ? coSearch.minCiters
      : minCoCitersChoice && minCoCitersChoice.anchorId === coAnchorId
        ? minCoCitersChoice.value
        : defaultMinCoCiters(citerCount),
  );

  // Co-cited works as shown (a chapter as its book), with how many works citing the searched
  // anchor cite each; empty unless they were found with the current anchors.
  const coCited = useMemo(() => {
    const shown = new Map();
    if (!coSearch) return shown;
    for (const [id, count] of coSearch.counts) {
      if (count < coSearch.minCiters) continue;
      const viewId = bookOf.get(id) ?? id;
      if (view.works.has(viewId)) shown.set(viewId, Math.max(count, shown.get(viewId) ?? 0));
    }
    return shown;
  }, [coSearch, bookOf, view.works]);

  // Looks through the reference lists of the works on the graph citing the anchor (or its
  // chapters), adding works at least minCoCiters of them cite, and highlights them.
  const handleFindCoCitations = async () => {
    const anchorId = coAnchorId;
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
    // The minimum is fixed from here on, so the default following the number of citers (which
    // expanding can change) doesn't move it out of step with what was added.
    setCoCitations({ anchorId, anchorsKey, ...result, citers: citerCount, minCiters });
    setMinCoCitersChoice({ anchorId, value: minCiters });
  };

  // A new minimum. After a search, it applies at once: added works that no longer qualify are
  // removed, and ones that now do are added, from the search's results.
  const handleMinCoCitersChange = (value) => {
    const next = Math.max(2, Math.min(maxCoCiters, value));
    setMinCoCitersChoice({ anchorId: coAnchorId, value: next });
    if (coSearch && coSearch.anchorId === coAnchorId) {
      setCoCitations({ ...coSearch, minCiters: next });
      applyCoCitations(coSearch, {
        minCiters: next,
        maxNodes: (graphOptions ?? options).maxNodes,
        keep: pinned,
      });
    }
  };

  // Which part of the graph (connected component, linked by citations either way) each work
  // is in. A work can look for a path to any anchor outside its part: one brought in by
  // expanding or adding a work, or another anchor not linked to it.
  const componentOf = useMemo(() => {
    const parts = new Map();
    connectedComponents(view.works.keys(), deriveEdges(view.works), view.anchorIds).forEach(
      (ids, index) => ids.forEach((id) => parts.set(id, index)),
    );
    return parts;
  }, [view]);
  const colorScheme = colorSchemeChoice ?? defaultColorScheme(view.anchorIds.length);
  // Which anchors each work is near (see anchorNeighborhoods), at the depths the graph was
  // built with: for coloring by anchor, and with several anchors for the details panel.
  const neighborhoods = useMemo(
    () =>
      view.anchorIds.length > 1 || colorScheme === 'neighborhood'
        ? anchorNeighborhoods(view, graphOptions ?? options)
        : null,
    [view, graphOptions, options, colorScheme],
  );
  // Coloring by academic field: how many works are in each field at the chosen level, which
  // of the most common get a color (each keeping it while it stays among them; adjusted while
  // rendering when the counts change), and each work's color.
  const fieldTally = useMemo(
    () => (colorScheme === 'field' ? fieldCounts(view.works.values(), fieldLevel) : null),
    [colorScheme, view.works, fieldLevel],
  );
  const [fieldColorState, setFieldColorState] = useState({ counts: null, colors: new Map() });
  if (fieldTally && fieldTally !== fieldColorState.counts) {
    setFieldColorState({
      counts: fieldTally,
      colors: assignFieldColors(fieldColorState.colors, fieldTally),
    });
  }
  // Only while coloring by field: otherwise there are no counts, and no field colors.
  const fieldColors =
    fieldTally && fieldTally === fieldColorState.counts ? fieldColorState.colors : null;
  const workFields = useMemo(
    () => (fieldColors ? workFieldColors(view.works.values(), fieldLevel, fieldColors) : null),
    [fieldColors, view.works, fieldLevel],
  );
  const fieldLegend = useMemo(() => {
    if (!workFields || !fieldTally) return { fields: [], other: 0, noTopic: 0 };
    const fields = [...fieldColors]
      .map(([key, slot]) => ({
        slot,
        name: fieldTally.get(key).name,
        count: fieldTally.get(key).count,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const values = [...workFields.values()];
    return {
      fields,
      other: values.filter((value) => value === 'other').length,
      noTopic: values.filter((value) => value == null).length,
    };
  }, [workFields, fieldColors, fieldTally]);

  // Looks for the shortest path from `fromId` to the nearest of `targetIds` (anchors).
  const handleFindPath = async (fromId, targetIds) => {
    const key = anchorsKey;
    setFindingPathFrom(fromId);
    const result = await findPath(fromId, targetIds);
    setFindingPathFrom(null);
    if (result) setPathSearch({ anchorsKey: key, fromId, targetIds, result });
  };

  const selected = shownId ? view.works.get(shownId) : null;
  // The selected work's citations on the graph, with where each came from.
  const selectedLinks = useMemo(
    () => (shownId ? graphLinks(view.works, shownId) : []),
    [view.works, shownId],
  );
  const shownPath =
    selected && pathSearch?.fromId === selected.id && pathSearch.anchorsKey === anchorsKey
      ? pathSearch
      : null;
  // The anchors the selected work has no path to on the graph, and which of them to look for
  // (an anchor's ID, or the nearest).
  const pathTargets =
    selected && canExpand(selected)
      ? view.anchorIds
          .filter(
            (id) => id !== selected.id && componentOf.get(id) !== componentOf.get(selected.id),
          )
          .map((id) => ({ id, title: view.works.get(id)?.title ?? 'Untitled' }))
      : [];
  const pathChoice =
    pathTarget?.fromId === selected?.id && pathTargets.some((t) => t.id === pathTarget.target)
      ? pathTarget.target
      : 'nearest';
  const parts = selected
    ? (partsOf.get(selected.id) ?? []).map((work) => ({
        work,
        citedByOnGraph: partCounts.get(work.id) ?? 0,
        citesOnGraph: partOutgoing.get(work.id) ?? 0,
      }))
    : [];
  const hasGraph = graph.works.size > 0;
  const anchorWorks = useMemo(
    () => graph.anchorIds.map((id) => graph.works.get(id)).filter(Boolean),
    [graph],
  );
  const graphName = anchorsName(anchorWorks);

  // What saving stores: what's needed to rebuild the graph (anchors, the options it was built
  // with, the works the user expanded, in order), how it's shown (filters, axis, pins) and the
  // user's notes.
  const saveState = useMemo(
    () => ({
      anchors: graph.anchorIds.map((id) => {
        const work = graph.works.get(id);
        return { id, ref: work ? shareableId(work) : null, title: work?.title ?? null };
      }),
      options: graphOptions ?? options,
      filters,
      // Pins of works no longer on the graph (dropped by a re-anchor) aren't worth keeping.
      view: {
        axisAngle,
        pinned: [...pinned].filter((id) => view.works.has(id)),
        colorScheme: colorSchemeChoice,
        fieldLevel,
      },
      expanded: [...graph.sticky],
      annotations: [...notes].map(([workId, body]) => ({
        target: { type: 'work', workId },
        kind: 'note',
        body,
      })),
    }),
    [
      graph,
      graphOptions,
      options,
      filters,
      axisAngle,
      pinned,
      colorSchemeChoice,
      fieldLevel,
      view,
      notes,
    ],
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
  // save at a time: a change made during one is saved after it. Only while the plan includes it.
  const autoSaving = autoSave && auth.can('autoSave') && auth.can('saveGraphs');
  useEffect(() => {
    // Just opened: once it's built, what's on screen is what was saved.
    if (lastSaved.current.baseline && idle && hasGraph) {
      lastSaved.current = { json: saveJson, graph };
    }
  }, [idle, hasGraph, saveJson, graph]);
  useEffect(() => {
    if (!autoSaving || !savedGraph || !idle || !hasGraph || saving.current) return undefined;
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
  }, [autoSaving, savedGraph, idle, hasGraph, saveJson, graph, autoSaveStatus]);

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
      const saved = await saveNow(graphName, false);
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
          onBuild={(ids, { asAnchors = false } = {}) => {
            closeAdvanced();
            if (asAnchors) handleBuild(ids);
            else handleBuild([ids[0]], ids.slice(1));
          }}
          anchorLimit={anchorLimit}
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
          onBuild={(id) => handleBuild([id])}
          onApply={hasGraph ? handleApplyOptions : undefined}
          onAdvanced={openAdvanced}
          advancedLocked={!auth.can('advancedSearch')}
          limits={limits}
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
          <Legend
            scheme={colorScheme}
            onSchemeChange={setColorSchemeChoice}
            fieldLevel={fieldLevel}
            onFieldLevelChange={setFieldLevel}
            anchorWorks={anchorWorks}
            fields={fieldLegend.fields}
            otherFields={fieldLegend.other}
            noTopic={fieldLegend.noTopic}
            coCited={coCited.size > 0}
            warnings={warnings.size > 0}
            statuses={new Set(graphStatuses.values())}
          />
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
              canSave={auth.can('saveGraphs')}
              savedGraph={savedGraph}
              defaultName={graphName}
              disabled={busy}
              onSave={handleSave}
              autoSave={autoSaving}
              autoSaveStatus={autoSaveStatus}
              onAutoSaveChange={auth.can('autoSave') ? handleAutoSaveChange : undefined}
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
            warnings={warnings}
            statuses={graphStatuses}
            coCitedIds={coCited}
            neighborhoods={colorScheme === 'neighborhood' ? neighborhoods : null}
            fieldColors={workFields}
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
          onMakeAnchor={() => handleReanchor([selected.id])}
          anchorControl={{
            count: graph.anchorIds.length,
            limit: anchorLimit,
            onAdd: () => handleAddAnchor(selected.id),
            onRemove: () => handleRemoveAnchor(selected.id),
          }}
          neighborhood={
            neighborhoods && graph.anchorIds.length > 1
              ? (neighborhoods.get(selected.id) ?? []).map((id) => ({
                  id,
                  index: graph.anchorIds.indexOf(id),
                  title: graph.works.get(id)?.title ?? 'Untitled',
                }))
              : null
          }
          manyAnchors={graph.anchorIds.length > 1}
          onMerged={mergeWork}
          referenceWarning={warnings.get(selected.id) ?? null}
          graphLinks={selectedLinks}
          onSelectWork={setSelectedId}
          readingStatus={statusOf(reading.statuses, selected)}
          onReadingStatusChange={
            reading.enabled ? (status) => reading.setStatus(selected.id, status) : undefined
          }
          readingStatusUnavailable={auth.user ? 'locked' : 'signed-out'}
          readingStatusError={reading.error}
          pinned={pinned.has(selected.id)}
          onTogglePin={() => togglePin(selected.id)}
          note={notes.get(selected.id) ?? ''}
          onNoteChange={(text) => setNote(selected.id, text)}
          signedIn={Boolean(auth.user)}
          coCitedBy={coCited.get(selected.id) ?? null}
          onFindCoCitations={isAnchor(graph, selected.id) ? handleFindCoCitations : undefined}
          findingCoCitations={findingCoCitations}
          coCitationControl={
            isAnchor(graph, selected.id)
              ? {
                  value: minCoCiters,
                  max: maxCoCiters,
                  citers: citerCount,
                  onChange: handleMinCoCitersChange,
                  locked: !auth.can('coCitations'),
                }
              : null
          }
          coCitationResult={
            coSearch?.anchorId === selected.id
              ? {
                  minCiters: minCoCiters,
                  citers: coSearch.citers,
                  found: [...coSearch.counts.values()].filter((n) => n >= minCoCiters).length,
                  // Works that didn't fit under the max works setting.
                  left: [...coSearch.counts].filter(
                    ([id, n]) => n >= minCoCiters && !graph.works.has(id),
                  ).length,
                }
              : null
          }
          pathControl={
            pathTargets.length > 0 || shownPath?.result.path
              ? {
                  targets: pathTargets,
                  choice: pathChoice,
                  onChoose: (target) => setPathTarget({ fromId: selected.id, target }),
                  finding: findingPathFrom === selected.id,
                  result: shownPath && {
                    ...shownPath.result,
                    targets: shownPath.targetIds.map((id) => ({
                      id,
                      title: view.works.get(id)?.title ?? 'Untitled',
                    })),
                  },
                  onFind: (targetIds) => handleFindPath(selected.id, targetIds),
                  locked: !auth.can('pathSearch'),
                  onSelect: setSelectedId,
                }
              : null
          }
          onCollapse={
            // Only works the user expanded (or earlier anchors) can be collapsed; the build's
            // own expansions would just come back.
            !isAnchor(graph, selected.id) &&
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

import { forceCollide } from 'd3-force';
import { Pin as PinShape } from 'lucide';
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { axisGeometry, DEFAULT_AXIS_ANGLE } from './axis.js';
import { deriveEdges, yearPositions } from './graphModel.js';
import {
  findCrossings,
  joinOf,
  movesAway,
  layoutLinks,
  linksAt,
  placeLinks,
  pointOnCurve,
  trunkSegments,
} from './linkRouting.js';
import { REFERENCE_ONLY } from './sourceTypeKeys.js';
import { iconPath2D, iconPathData } from './sourceTypes.js';
import { connectedComponents, laneCenters } from './lanes.js';
import { layoutSpread } from './spacing.js';

// Node radius = NODE_MIN_RADIUS + NODE_GROWTH * log10(1 + total citations). Totals run from 0
// to thousands, so the log keeps a classic from dwarfing the graph: 10 citations give about
// 15, 100 about 21, 1,000 about 27. The minimum keeps every circle big enough for its icon.
const NODE_MIN_RADIUS = 9;
const NODE_GROWTH = 6;

// Ring around expanded works, in screen pixels: its width, and its gap from the circle's edge.
const EXPANDED_RING_WIDTH = 2;
const EXPANDED_RING_GAP = 3.5;

// Ring around works co-cited with the anchor, in screen pixels: as wide as the expanded ring,
// at the same gap, or just outside the expanded ring on a work that has both.
const CO_CITED_RING_WIDTH = 2;
const CO_CITED_RING_GAP_OUTSIDE_EXPANDED = EXPANDED_RING_GAP + EXPANDED_RING_WIDTH + 2;

// Badge on pinned works, in screen pixels: its radius, and its pin icon's size. It sits on the
// circle's top right edge and stays the same size at any zoom, so pins stay noticeable.
const PIN_BADGE_RADIUS = 9;
const PIN_ICON_SIZE = 12;
let pinPath = null;
const pinPath2D = () => {
  if (!pinPath && typeof Path2D !== 'undefined') pinPath = new Path2D(iconPathData(PinShape));
  return pinPath;
};

// Source-type icons are drawn inside circles at least this many screen pixels in radius;
// smaller ones would be illegible clutter.
const ICON_MIN_SCREEN_RADIUS = 7;
// Icon box side as a fraction of the circle's diameter (lucide icons are drawn on 24x24).
const ICON_FILL = 0.6;

// force-graph sizes nodes as sqrt(val) * nodeRelSize. With nodeRelSize 1, val = radius², which
// keeps arrowheads and hit areas on the circle's edge.
const nodeVal = (count) => (NODE_MIN_RADIUS + NODE_GROWTH * Math.log10(1 + count)) ** 2;
const radiusOf = (val) => Math.sqrt(val);

// Layout tuning. Years sit close together along the time axis; works spread out across it.
// Large graphs get more room across the axis: repulsion (strength and range) and the gap
// between circles are scaled by layoutSpread. Year spacing isn't: stretching the axis also
// stretches empty decades, and fitting that shrinks every circle. (Repulsion scaled by the
// factor's square spread works so far that fitted circles became dots.)
//
// Repulsion grows more slowly than the spread factor (CHARGE_GROWTH, CHARGE_RANGE_GROWTH):
// small graphs span decades along the axis but little across it, so they get strong
// repulsion, while large ones already fill the view across it. Measured: Manchus and Han
// (41 works) went from 4.2 times as long along the axis as across to 2.7, Thompson's 21
// citing works from a median gap of 0.4 radii to 1.2; a 288-work graph is about as before
// (stronger repulsion there halved the size circles are shown at).
const YEAR_SPACING = 15; // Distance between consecutive years along the axis.
const YEAR_PULL = 0.5; // How firmly works hold their year's position.
const ACROSS_PULL = 0.004; // Gentle pull back toward the axis, so the graph doesn't drift.
const CHARGE = -150; // Repulsion between works. Mostly spreads works across the axis,
const CHARGE_RANGE = 300; // because YEAR_PULL resists movement along it.
const CHARGE_GROWTH = 0.4; // Strength grows with spread ** this,
const CHARGE_RANGE_GROWTH = 0.5; // and range with spread ** this.
const COLLIDE_PADDING = 4; // Minimum gap between circles.
// Parts of the graph with no path between them (see lanes.js) sit in separate bands across the
// axis, this far apart (scaled by layoutSpread), each pulled there as a whole.
const LANE_GAP = 80;
const LANE_PULL = 0.15;

// Link widths. Links to the anchor stand out from links between other works; links to the
// selected work are highlighted by adding LINK_SELECTED_EXTRA to either.
const LINK_WIDTH = 0.5;
const ANCHOR_LINK_WIDTH = 2.5;
const LINK_SELECTED_EXTRA = 1;
// Links bend around circles in their way, keeping at least this gap (see linkRouting.js).
const LINK_CLEARANCE = 3;
// Links to the same work merge as soon as they come this close: a small circle's diameter.
const LINK_MERGE_DISTANCE = 2 * NODE_MIN_RADIUS;
// Branches widen to their trunk's width over this many screen pixels before a junction (at
// most RAMP_MAX_SHARE of the branch), drawn as RAMP_STEPS segments of growing width.
const RAMP_PIXELS = 30;
const RAMP_MAX_SHARE = 0.4;
const RAMP_STEPS = 12;
// While nodes move, links are re-planned (bundled and routed around circles) only every
// ROUTE_EVERY frames, without merging at crossings; frames in between just move the planned
// routes with their nodes. Once the layout settles, one full plan merges crossings, and later
// frames (hovers, zooms) reuse it until nodes move again.
const ROUTE_EVERY = 4;
// Arrowhead length in graph units, plus this many line widths, so thick lines get visible heads.
const ARROW_LENGTH = 4;
const ARROW_PER_WIDTH = 2;

/**
 * Fills an arrowhead (force-graph's shape) with its tip `back` short of `point`, pointing along
 * the unit vector (dx, dy).
 */
function paintArrow(ctx, point, dx, dy, back, length) {
  const tipX = point.x - dx * back;
  const tipY = point.y - dy * back;
  const halfWidth = length / 1.6 / 2;
  const tailX = tipX - dx * length;
  const tailY = tipY - dy * length;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tailX - dy * halfWidth, tailY + dx * halfWidth);
  ctx.lineTo(tipX - dx * length * 0.8, tipY - dy * length * 0.8);
  ctx.lineTo(tailX + dy * halfWidth, tailY - dx * halfWidth);
  ctx.fill();
}

/**
 * Pulls each node toward its year's position along the time axis (node.targetU). Movement
 * across the axis gets only a gentle pull toward its lane's center, so works from the same
 * period spread out side by side. `getGeometry` returns the current axisGeometry, so rotating
 * the axis doesn't require replacing the force.
 *
 * `getLanes` returns the graph's connected components as node arrays, the anchor's first, and
 * the gap between them. The anchor's component is centered on the axis; each other one has its
 * own band beside it (laneCenters), and is moved there as a whole (`laneStrength`), so parts
 * of the graph with no path between them don't interleave.
 */
function yearForce(getGeometry, getLanes, { strength, acrossStrength, laneStrength }) {
  const force = (alpha) => {
    const { toU, toV, alongAcross } = getGeometry();
    const { components, gap } = getLanes();
    const vs = components.map((members) =>
      members.map((node) => (node.x == null ? 0 : toV(node.x, node.y))),
    );
    const extents = components.map((members, i) => {
      let min = Infinity;
      let max = -Infinity;
      members.forEach((node, j) => {
        const r = radiusOf(node.val);
        min = Math.min(min, vs[i][j] - r);
        max = Math.max(max, vs[i][j] + r);
      });
      return { min, max };
    });
    const targets = laneCenters(extents, gap);
    components.forEach((members, i) => {
      const center = (extents[i].min + extents[i].max) / 2;
      // A single component (the usual case) keeps only the per-work pull toward the axis.
      const shift = i === 0 ? 0 : (targets[i] - center) * laneStrength;
      members.forEach((node, j) => {
        if (node.x == null) return;
        const across = ((targets[i] - vs[i][j]) * acrossStrength + shift) * alpha;
        const along =
          node.targetU == null ? 0 : (node.targetU - toU(node.x, node.y)) * strength * alpha;
        const { vx, vy } = alongAcross(along, across);
        node.vx += vx;
        node.vy += vy;
      });
    });
  };
  force.initialize = () => {};
  return force;
}

/** Deterministic value in [-1, 1) from a string, for stable initial jitter. */
function jitter(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return ((hash >>> 0) % 2000) / 1000 - 1;
}

const COLOR_VARS = {
  anchor: '--node-anchor',
  citing: '--node-citing',
  cited: '--node-cited',
  referenceOnly: '--node-reference-only',
  selected: '--node-selected',
  expanded: '--node-expanded',
  pin: '--node-pin',
  coCited: '--node-co-cited',
  iconOnPin: '--node-icon-on-pin',
  outline: '--node-outline',
  iconOnAnchor: '--node-icon-on-anchor',
  iconOnCiting: '--node-icon-on-citing',
  iconOnCited: '--node-icon-on-cited',
  iconOnReferenceOnly: '--node-icon-on-reference-only',
  link: '--graph-link',
  linkActive: '--graph-link-active',
  label: '--text',
  labelBg: '--surface',
  axis: '--graph-axis',
  axisLabel: '--muted',
};

/**
 * Returns a function converting any CSS color the browser understands (including oklab() and
 * color(), which is how derived color-mix() tokens compute) into a plain rgba() string, by
 * painting it on a 1x1 canvas and reading the pixel back. With a `background`, the color is
 * painted over it, giving the opaque color it shows as there. Falls back to the input where
 * canvas isn't available (e.g. jsdom).
 */
function createColorNormalizer() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext?.('2d', { willReadFrequently: true });
  if (!ctx) return (color) => color;
  return (color, background) => {
    ctx.clearRect(0, 0, 1, 1);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
}

/**
 * The background showing behind `element` (the canvas itself is transparent): the first
 * ancestor background that isn't fully transparent, normalized with `normalize`.
 */
function backgroundBehind(element, normalize) {
  for (let el = element; el; el = el.parentElement) {
    const color = normalize(getComputedStyle(el).backgroundColor);
    if (!color.endsWith(', 0.000)')) return color;
  }
  return 'white';
}

/**
 * Reads graph colors from CSS custom properties, and re-reads them when the theme changes.
 *
 * Tokens are often derived (`color-mix()` of palette variables), and reading a custom property
 * returns that unevaluated text. So each token is applied to a hidden probe element, the
 * browser computes it, and the result is normalized to rgba() for the canvas.
 *
 * `link` comes back opaque: the translucent token as it looks over the graph's background.
 * Overlapping links then look the same as one link, instead of darkening where they stack.
 */
function useThemeColors(ref) {
  const [colors, setColors] = useState(null);
  useEffect(() => {
    const normalize = createColorNormalizer();
    const read = () => {
      const probe = document.createElement('span');
      probe.style.display = 'none';
      (ref.current ?? document.body).appendChild(probe);
      const resolved = {};
      for (const [key, name] of Object.entries(COLOR_VARS)) {
        probe.style.color = `var(${name})`;
        resolved[key] = normalize(getComputedStyle(probe).color);
      }
      probe.remove();
      resolved.link = normalize(resolved.link, backgroundBehind(ref.current, normalize));
      setColors(resolved);
    };
    read();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', read);
    return () => media.removeEventListener('change', read);
  }, [ref]);
  return colors;
}

function useElementSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** " (1971)" for a tooltip; " (before 1953)" for a listed year set aside as implausible. */
const yearLabel = (work, layout) => {
  if (layout?.listedYear != null) return ` (before ${layout.citedFrom})`;
  return work.year ? ` (${work.year})` : '';
};

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * Force-directed canvas rendering of the citation graph.
 *
 * Works are laid out by year along a time axis `axisAngle` degrees below horizontal: older
 * works up and to the left, newer works down and to the right (see layoutYears for undated
 * works). Faint lines across the axis mark years.
 *
 * Every work stays in the simulation; filtered-out works are only hidden (nodeVisibility),
 * so filtering doesn't reshuffle the layout.
 */
export default function GraphView({
  graph,
  sizes,
  expandedIds = new Set(),
  pinnedIds = new Set(),
  coCitedIds = new Map(),
  years,
  visible,
  selectedId,
  onSelect,
  building = false,
  axisAngle = DEFAULT_AXIS_ANGLE,
  fitKey = graph.anchorId,
}) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const { width, height } = useElementSize(containerRef);
  const colors = useThemeColors(containerRef);
  const geometry = useMemo(() => axisGeometry(axisAngle), [axisAngle]);
  // The year force runs outside React, so it reads the current geometry from a ref.
  const geometryRef = useRef(geometry);
  // Link layout plan, re-made every few frames (see paintFramePre).
  const routing = useRef({
    frame: 0,
    moving: false, // The simulation is running (set by its tick and stop events).
    stale: true, // Nodes moved since the last plan.
    data: null,
    visible: null,
    bundles: [],
  });
  // Bumped when the layout settles, so the canvas redraws once more with a full plan.
  const [, setSettled] = useState(0);

  // force-graph stores positions on node objects, so reuse them across updates to keep the
  // layout stable as works are added.
  const [nodeCache] = useState(() => new Map());
  // More works need more room, or they pack edge to edge with no space for links between them.
  const spread = layoutSpread(graph.works.size);
  // Years near the anchor's are spaced further apart than distant ones.
  const anchorYear = years.get(graph.anchorId)?.year ?? null;
  const positions = useMemo(
    () =>
      yearPositions(
        [...years.values()].map((y) => y.year).filter((y) => y != null),
        YEAR_SPACING,
        anchorYear,
      ),
    [years, anchorYear],
  );
  const data = useMemo(() => {
    for (const id of nodeCache.keys()) if (!graph.works.has(id)) nodeCache.delete(id);
    const links = deriveEdges(graph.works);
    const componentIds = connectedComponents(graph.works.keys(), links, graph.anchorId);
    // Where each component's placed works are across the axis, to start its new works there.
    const placedV = (ids) =>
      ids
        .map((id) => nodeCache.get(id))
        .filter((node) => node?.x != null)
        .map((node) => geometry.toV(node.x, node.y));
    const allPlaced = placedV([...nodeCache.keys()]);
    let outermost = allPlaced.length ? Math.max(...allPlaced) : 0;
    const startV = new Map();
    componentIds.forEach((ids, index) => {
      const placed = placedV(ids);
      let base;
      if (placed.length) base = placed.reduce((a, b) => a + b, 0) / placed.length;
      else if (index === 0) base = 0;
      else {
        // A new part with no path to the rest: start it beside everything, in a lane of its
        // own, rather than on the axis among works it isn't related to.
        base = outermost + LANE_GAP * spread + 30 * spread;
        outermost = base + 30 * spread;
      }
      for (const id of ids) startV.set(id, base);
    });
    const byId = new Map();
    const nodes = [...graph.works.values()].map((work) => {
      let node = nodeCache.get(work.id);
      const year = years.get(work.id)?.year;
      const targetU = year == null ? null : positions.get(year);
      if (!node) {
        // Start new works at their year, so they don't fly across the graph to get there.
        node = {
          id: work.id,
          ...geometry.fromUV(targetU ?? 0, startV.get(work.id) + jitter(work.id) * 60 * spread),
        };
        nodeCache.set(work.id, node);
      }
      node.work = work;
      node.relation = graph.relations.get(work.id);
      node.val = nodeVal(sizes.get(work.id) ?? 0);
      node.targetU = targetU;
      byId.set(work.id, node);
      return node;
    });
    const components = componentIds.map((ids) => ids.map((id) => byId.get(id)));
    return { nodes, links, components };
  }, [graph, sizes, years, positions, nodeCache, geometry, spread]);
  // The force reads the current components and gap through a ref, like the geometry.
  const lanesRef = useRef({ components: [], gap: 0 });
  useEffect(() => {
    lanesRef.current = { components: data.components, gap: LANE_GAP * spread };
  }, [data, spread]);

  // Year ticks: whole publication years only, not inferred midpoints.
  const ticks = useMemo(
    () => [...positions].filter(([year]) => Number.isInteger(year)),
    [positions],
  );

  const ready = Boolean(colors) && width > 0;
  useEffect(() => {
    const fg = graphRef.current;
    if (!ready || !fg) return;
    // The year force fixes positions along the time axis. d3's default centering force would
    // shift every node to keep their average at the origin, pulling them all off their years.
    fg.d3Force('center', null);
    fg.d3Force(
      'year',
      yearForce(
        () => geometryRef.current,
        () => lanesRef.current,
        { strength: YEAR_PULL, acrossStrength: ACROSS_PULL, laneStrength: LANE_PULL },
      ),
    );
    fg.d3Force(
      'collide',
      forceCollide((node) => radiusOf(node.val) + COLLIDE_PADDING * spread),
    );
    // Citations always join works from different years, so a strong link force would fight
    // the time axis. Keep links weak; they only loosely group related works across it.
    fg.d3Force('link').strength(0.02);
    // Limit repulsion to nearby works: otherwise many works on one side (e.g. all the works
    // citing the anchor) push a node off its year.
    fg.d3Force('charge')
      .strength(CHARGE * spread ** CHARGE_GROWTH)
      .distanceMax(CHARGE_RANGE * spread ** CHARGE_RANGE_GROWTH);
    fg.d3ReheatSimulation();
  }, [ready, spread]);

  // Rotating the axis moves every node straight to its rotated position (same place along and
  // across the axis), rather than letting the simulation drag nodes there and reshuffle.
  useEffect(() => {
    const previous = geometryRef.current;
    if (previous === geometry) return;
    geometryRef.current = geometry;
    for (const node of nodeCache.values()) {
      if (node.x == null) continue;
      Object.assign(
        node,
        geometry.fromUV(previous.toU(node.x, node.y), previous.toV(node.x, node.y)),
      );
      if (node.fx != null) {
        const pinned = geometry.fromUV(
          previous.toU(node.fx, node.fy),
          previous.toV(node.fx, node.fy),
        );
        node.fx = pinned.x;
        node.fy = pinned.y;
      }
      node.vx = 0;
      node.vy = 0;
    }
    graphRef.current?.zoomToFit(200, 40);
  }, [geometry, nodeCache]);

  // Automation hook (browser drivers, e.g. the run-tracer skill): with ?automation in the URL,
  // expose where each node is on screen, since nodes are canvas pixels, not DOM elements.
  // Off by default.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('automation')) return undefined;
    window.__tracerAutomation = {
      // Merged-line stats: how many bundles, how long their trunks are, and what stopped them.
      bundles: () =>
        routing.current.bundles.map(({ links, reach, limitedBy, node }) => ({
          node: node.id,
          links: links.length,
          reach: Math.round(reach),
          limitedBy,
          lengths: links.map((link) =>
            Math.round(Math.hypot(link.target.x - link.source.x, link.target.y - link.source.y)),
          ),
        })),
      // Links to the same work that cross on the way there, by kind.
      // Merged links whose route heads back away from the node they merge at (should be 0).
      backwards: () =>
        routing.current.bundles.reduce(
          (n, bundle) =>
            n +
            bundle.links.filter((link) => link.route && movesAway(link, bundle.outgoing)).length,
          0,
        ),
      // Time for one full plan, with crossings merged, as when the layout settles.
      planMs: () => {
        const start = performance.now();
        layoutLinks(
          data.links,
          data.nodes.filter((node) => visible.has(node.id)),
          (node) => radiusOf(node.val),
          LINK_CLEARANCE,
          (link) => visible.has(link.source.id) && visible.has(link.target.id),
          { mergeDistance: LINK_MERGE_DISTANCE },
        );
        return Math.round(performance.now() - start);
      },
      // Each work's place along (u) and across (v) the time axis, in graph units, where its
      // year is along it (targetU), and which connected component (lane) it's in: 0 is the
      // anchor's.
      layout: () =>
        data.components.flatMap((members, component) =>
          members.map((node) => ({
            id: node.id,
            component,
            u: Math.round(geometry.toU(node.x, node.y)),
            targetU: node.targetU == null ? null : Math.round(node.targetU),
            v: Math.round(geometry.toV(node.x, node.y)),
            r: Math.round(radiusOf(node.val)),
          })),
        ),
      crossings: () => {
        const found = findCrossings(
          data.links,
          (node) => radiusOf(node.val) + 8,
          LINK_MERGE_DISTANCE,
        );
        const kinds = {};
        for (const { kind } of found) kinds[kind] = (kinds[kind] ?? 0) + 1;
        return { total: found.length, ...kinds };
      },
      nodes: () => {
        const fg = graphRef.current;
        const canvas = containerRef.current?.querySelector('canvas');
        if (!fg || !canvas) return [];
        const rect = canvas.getBoundingClientRect();
        const scale = fg.zoom();
        return data.nodes
          .filter((node) => node.x != null && visible.has(node.id))
          .map((node) => {
            const point = fg.graph2ScreenCoords(node.x, node.y);
            return {
              id: node.id,
              relation: node.relation,
              title: node.work.title,
              type: node.work.type,
              x: rect.left + point.x,
              y: rect.top + point.y,
              radius: radiusOf(node.val) * scale,
            };
          })
          .filter(
            (n) => n.x >= rect.left && n.x <= rect.right && n.y >= rect.top && n.y <= rect.bottom,
          );
      },
    };
    return () => {
      delete window.__tracerAutomation;
    };
  }, [data, visible, geometry]);

  // Fit the view once the first layout settles after each run (a build, re-anchor, or options
  // change), identified by `fitKey`. Expansions don't change it, so they don't move the view.
  const fitted = useRef(null);
  const handleEngineTick = () => {
    routing.current.moving = true;
    routing.current.stale = true;
  };
  const handleEngineStop = () => {
    routing.current.moving = false;
    // force-graph stops redrawing once settled; a re-render redraws once more, with crossings
    // merged (paintFramePre).
    setSettled((n) => n + 1);
    // Wait for the whole build: the graph arrives in stages, and fitting to an early stage
    // (say, just the anchor) leaves the view zoomed in on a small part of the time axis.
    if (building || !graph.anchorId || fitted.current === fitKey) return;
    fitted.current = fitKey;
    graphRef.current?.zoomToFit(400, 40);
  };

  // When a build finishes, restart the simulation so it settles once more and fits the view
  // above; the last progress update may already have settled.
  useEffect(() => {
    if (!building && graph.anchorId && fitted.current !== fitKey) {
      graphRef.current?.d3ReheatSimulation();
    }
  }, [building, graph.anchorId, fitKey]);

  const endId = (end) => (typeof end === 'object' ? end.id : end);
  const isAnchorLink = (link) =>
    endId(link.source) === graph.anchorId || endId(link.target) === graph.anchorId;
  const isActiveLink = (link) =>
    selectedId != null && (endId(link.source) === selectedId || endId(link.target) === selectedId);

  const paintNode = (node, ctx, scale) => {
    const r = radiusOf(node.val);
    const isSelected = node.id === selectedId;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    // Works not on OpenAlex are grey whichever way they joined the graph.
    const referenceOnly = node.work.type === REFERENCE_ONLY;
    ctx.fillStyle = referenceOnly ? colors.referenceOnly : (colors[node.relation] ?? colors.cited);
    ctx.fill();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
    if (isSelected) {
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = colors.selected;
      ctx.stroke();
    }
    // Expanded works get a ring just outside the circle, clear of the selection stroke.
    if (expandedIds.has(node.id)) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + EXPANDED_RING_GAP / scale, 0, 2 * Math.PI);
      ctx.lineWidth = EXPANDED_RING_WIDTH / scale;
      ctx.strokeStyle = colors.expanded;
      ctx.stroke();
    }

    // Works co-cited with the anchor get a thin ring in the citing works' color.
    if (coCitedIds.has(node.id)) {
      const gap = expandedIds.has(node.id) ? CO_CITED_RING_GAP_OUTSIDE_EXPANDED : EXPANDED_RING_GAP;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + gap / scale, 0, 2 * Math.PI);
      ctx.lineWidth = CO_CITED_RING_WIDTH / scale;
      ctx.strokeStyle = colors.coCited;
      ctx.stroke();
    }

    // Source-type icon, once the circle is big enough on screen to read it.
    const icon = r * scale >= ICON_MIN_SCREEN_RADIUS ? iconPath2D(node.work.type) : null;
    if (icon) {
      const size = 2 * r * ICON_FILL;
      ctx.save();
      ctx.translate(node.x - size / 2, node.y - size / 2);
      ctx.scale(size / 24, size / 24);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = referenceOnly
        ? colors.iconOnReferenceOnly
        : node.relation === 'anchor'
          ? colors.iconOnAnchor
          : node.relation === 'citing'
            ? colors.iconOnCiting
            : colors.iconOnCited;
      ctx.stroke(icon);
      ctx.restore();
    }

    // Pinned works (always shown, whatever the filters) get a pin badge on their top right.
    const pin = pinnedIds.has(node.id) ? pinPath2D() : null;
    if (pin) {
      const cx = node.x + r * Math.SQRT1_2;
      const cy = node.y - r * Math.SQRT1_2;
      ctx.beginPath();
      ctx.arc(cx, cy, PIN_BADGE_RADIUS / scale, 0, 2 * Math.PI);
      ctx.fillStyle = colors.pin;
      ctx.fill();
      const size = PIN_ICON_SIZE / scale;
      ctx.save();
      ctx.translate(cx - size / 2, cy - size / 2);
      ctx.scale(size / 24, size / 24);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = colors.iconOnPin;
      ctx.stroke(pin);
      ctx.restore();
    }

    // Label the anchor and selection always, other works once zoomed in enough to read them.
    const showLabel = isSelected || node.relation === 'anchor' || scale > 2.5;
    if (!showLabel || !node.work.title) return;
    const fontSize = 12 / scale;
    const label = truncate(node.work.title, 40);
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    const textWidth = ctx.measureText(label).width;
    const y = node.y + r + fontSize * 0.9;
    ctx.fillStyle = colors.labelBg;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(
      node.x - textWidth / 2 - 2 / scale,
      y - fontSize * 0.6,
      textWidth + 4 / scale,
      fontSize * 1.2,
    );
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.label;
    ctx.fillText(label, node.x, y);
  };

  const isLinkVisible = (link) =>
    visible.has(endId(link.source)) && visible.has(endId(link.target));
  const linkWidth = (link) =>
    (isAnchorLink(link) ? ANCHOR_LINK_WIDTH : LINK_WIDTH) +
    (isActiveLink(link) ? LINK_SELECTED_EXTRA : 0);
  const arrowLength = (width, scale) => ARROW_LENGTH + (ARROW_PER_WIDTH * width) / scale;

  // A trunk is as thick as the links it carries at that point: `count` of its links.
  const trunkWidth = (bundle, count = bundle.links.length) =>
    Math.max(...bundle.links.map((link) => (isAnchorLink(link) ? ANCHOR_LINK_WIDTH : LINK_WIDTH))) *
    Math.sqrt(count);

  // Widens a branch from `width` to the trunk's width `to` (where it joins) as it nears its
  // start (atStart) or end, so it doesn't step up abruptly. Links are opaque, so the
  // overlapping segments don't show.
  const paintRamp = (ctx, route, atStart, width, to, scale) => {
    const { start, controls, end } = route;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) return;
    const span = Math.min(RAMP_PIXELS / scale / length, RAMP_MAX_SHARE);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = colors.link;
    for (let i = 0; i < RAMP_STEPS; i++) {
      // Progress toward the junction, 0 to 1, eased so the width grows smoothly.
      const p = (i + 0.5) / RAMP_STEPS;
      const eased = p * p * (3 - 2 * p);
      const t0 = span * (1 - i / RAMP_STEPS);
      const t1 = span * (1 - (i + 1) / RAMP_STEPS);
      const a = pointOnCurve(start, controls, end, atStart ? t0 : 1 - t0);
      const b = pointOnCurve(start, controls, end, atStart ? t1 : 1 - t1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineWidth = (width + (to - width) * eased) / scale;
      ctx.stroke();
    }
    ctx.restore();
  };

  // A link's free part, from its start (node or junction) to its end. Trunks (paintTrunks)
  // join bundled ends to their nodes; a selected link also redraws its own share of them, so
  // the highlight runs node to node without implying the whole bundle is selected.
  const paintLink = (link, ctx, scale) => {
    const { route } = link;
    if (!route) return;
    const { start, controls, end, sourceBundle, targetBundle } = route;
    const active = isActiveLink(link);
    const width = linkWidth(link);
    const color = active ? colors.linkActive : colors.link;
    // Ramps use the trunk's look; a selected link is drawn over them.
    const plainWidth = isAnchorLink(link) ? ANCHOR_LINK_WIDTH : LINK_WIDTH;
    const joinedWidth = (bundle) => trunkWidth(bundle, linksAt(bundle, joinOf(bundle, link)));
    if (sourceBundle) paintRamp(ctx, route, true, plainWidth, joinedWidth(sourceBundle), scale);
    if (targetBundle) paintRamp(ctx, route, false, plainWidth, joinedWidth(targetBundle), scale);
    ctx.beginPath();
    if (active && sourceBundle) {
      ctx.moveTo(link.source.x, link.source.y);
      ctx.lineTo(start.x, start.y);
    } else ctx.moveTo(start.x, start.y);
    if (controls.length === 2)
      ctx.bezierCurveTo(controls[0].x, controls[0].y, controls[1].x, controls[1].y, end.x, end.y);
    else if (controls.length === 1)
      ctx.quadraticCurveTo(controls[0].x, controls[0].y, end.x, end.y);
    else ctx.lineTo(end.x, end.y);
    if (active && targetBundle) ctx.lineTo(link.target.x, link.target.y);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width / scale;
    ctx.strokeStyle = color;
    ctx.stroke();

    // A bundled target gets one arrowhead on its trunk instead, unless this link is selected.
    if (targetBundle && !active) return;
    const { target } = link;
    // The arrow points along the line's last stretch into the target.
    const from = targetBundle ? end : ([...controls].reverse().find((c) => c !== end) ?? start);
    const length = Math.hypot(target.x - from.x, target.y - from.y);
    if (length === 0) return;
    ctx.fillStyle = color;
    paintArrow(
      ctx,
      target,
      (target.x - from.x) / length,
      (target.y - from.y) / length,
      radiusOf(target.val),
      arrowLength(width, scale),
    );
  };

  // A bundle's shared part, from its node to the junction, thicker the more links it carries.
  const paintTrunks = (ctx, scale, bundles) => {
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = colors.link;
    ctx.fillStyle = colors.link;
    for (const bundle of bundles) {
      const { node, junction, outgoing, direction } = bundle;
      // Thinner past each point where a link merged in partway (see mergeCrossings).
      for (const { from, to, count } of trunkSegments(bundle)) {
        ctx.beginPath();
        ctx.moveTo(node.x + direction.x * from, node.y + direction.y * from);
        ctx.lineTo(node.x + direction.x * to, node.y + direction.y * to);
        ctx.lineWidth = trunkWidth(bundle, count) / scale;
        ctx.stroke();
      }
      const width = trunkWidth(bundle);
      if (outgoing) continue;
      const length = Math.hypot(node.x - junction.x, node.y - junction.y);
      paintArrow(
        ctx,
        node,
        (node.x - junction.x) / length,
        (node.y - junction.y) / length,
        radiusOf(node.val),
        arrowLength(width, scale),
      );
    }
    ctx.restore();
  };

  // Runs before each frame's links are drawn, so they follow the nodes as the layout moves.
  // Planning is the expensive part (see ROUTE_EVERY): while nodes move it runs every few frames,
  // and once they settle, once more with crossings merged; frames after that only place.
  const paintFramePre = (ctx, scale) => {
    const state = routing.current;
    const changed = state.data !== data || state.visible !== visible;
    const replan = changed || (state.stale && (!state.moving || state.frame % ROUTE_EVERY === 0));
    if (replan) {
      state.bundles = layoutLinks(
        data.links,
        data.nodes.filter((node) => visible.has(node.id)),
        (node) => radiusOf(node.val),
        LINK_CLEARANCE,
        isLinkVisible,
        { mergeCrossings: !state.moving, mergeDistance: LINK_MERGE_DISTANCE },
      );
      state.data = data;
      state.visible = visible;
      if (!state.moving) state.stale = false;
    } else {
      placeLinks(data.links, state.bundles);
    }
    state.frame++;
    paintYearAxis(ctx, scale);
    paintTrunks(ctx, scale, state.bundles);
  };

  const paintYearAxis = (ctx, scale) => {
    if (ticks.length === 0 || data.nodes.length === 0) return;
    let spread = 0;
    for (const node of data.nodes) {
      if (node.x != null)
        spread = Math.max(spread, Math.abs(geometry.toV(node.x, node.y)) + radiusOf(node.val));
    }
    const reach = spread + 30 / scale;
    const fontSize = 11 / scale;
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1 / scale;

    // Skip ticks closer than ~48px on screen to the last one drawn.
    let lastU = -Infinity;
    for (const [year, u] of ticks) {
      if ((u - lastU) * scale < 48) continue;
      lastU = u;
      const start = geometry.fromUV(u, -reach);
      const end = geometry.fromUV(u, reach);
      ctx.strokeStyle = colors.axis;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.fillStyle = colors.axisLabel;
      ctx.fillText(String(year), end.x + 4 / scale, end.y);
    }
  };

  const paintPointerArea = (node, color, ctx) => {
    ctx.beginPath();
    ctx.arc(node.x, node.y, radiusOf(node.val) + 2, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  };

  return (
    <div ref={containerRef} className="graph-view">
      {colors && width > 0 && (
        <ForceGraph2D
          ref={graphRef}
          width={width}
          height={height}
          graphData={data}
          nodeRelSize={1}
          nodeVal="val"
          nodeLabel={(node) =>
            escapeHtml(
              `${node.work.title ?? 'Untitled'}${yearLabel(node.work, years.get(node.id))}`,
            )
          }
          nodeVisibility={(node) => visible.has(node.id)}
          linkVisibility={isLinkVisible}
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          // Links are drawn here (see linkRouting.js), and aren't interactive.
          linkCanvasObjectMode={() => 'replace'}
          linkCanvasObject={paintLink}
          linkPointerAreaPaint={() => {}}
          onNodeClick={(node) => onSelect(node.id)}
          onBackgroundClick={() => onSelect(null)}
          onEngineTick={handleEngineTick}
          onEngineStop={handleEngineStop}
          onRenderFramePre={paintFramePre}
          cooldownTicks={150}
        />
      )}
    </div>
  );
}

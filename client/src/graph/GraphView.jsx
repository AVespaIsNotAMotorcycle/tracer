import { forceCollide } from 'd3-force';
import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { axisGeometry, DEFAULT_AXIS_ANGLE } from './axis.js';
import { deriveEdges, yearPositions } from './graphModel.js';
import { iconPath2D } from './sourceTypes.js';

// Node radius = NODE_MIN_RADIUS + NODE_GROWTH * sqrt(in-graph citations). The minimum keeps
// every circle big enough to hold its source-type icon; size still grows with citations.
const NODE_MIN_RADIUS = 9;
const NODE_GROWTH = 3;

// Source-type icons are drawn inside circles at least this many screen pixels in radius;
// smaller ones would be illegible clutter.
const ICON_MIN_SCREEN_RADIUS = 7;
// Icon box side as a fraction of the circle's diameter (lucide icons are drawn on 24x24).
const ICON_FILL = 0.6;

// force-graph sizes nodes as sqrt(val) * nodeRelSize. With nodeRelSize 1, val = radius², which
// keeps arrowheads and hit areas on the circle's edge.
const nodeVal = (count) => (NODE_MIN_RADIUS + NODE_GROWTH * Math.sqrt(count)) ** 2;
const radiusOf = (val) => Math.sqrt(val);

// Layout tuning. Years sit close together along the time axis; works spread out across it.
const YEAR_SPACING = 15; // Distance between consecutive years along the axis.
const YEAR_PULL = 0.5; // How firmly works hold their year's position.
const ACROSS_PULL = 0.008; // Gentle pull back toward the axis, so the graph doesn't drift.
const CHARGE = -90; // Repulsion between works. Mostly spreads works across the axis,
const CHARGE_RANGE = 200; // because YEAR_PULL resists movement along it.
const COLLIDE_PADDING = 4; // Minimum gap between circles.

/**
 * Pulls each node toward its year's position along the time axis (node.targetU). Movement
 * across the axis gets only a gentle pull toward it, so works from the same period spread out
 * side by side. `getGeometry` returns the current axisGeometry, so rotating the axis doesn't
 * require replacing the force.
 */
function yearForce(getGeometry, strength, acrossStrength) {
  let nodes = [];
  const force = (alpha) => {
    const { toU, toV, alongAcross } = getGeometry();
    for (const node of nodes) {
      const across = -toV(node.x, node.y) * acrossStrength * alpha;
      const along =
        node.targetU == null ? 0 : (node.targetU - toU(node.x, node.y)) * strength * alpha;
      const { vx, vy } = alongAcross(along, across);
      node.vx += vx;
      node.vy += vy;
    }
  };
  force.initialize = (n) => {
    nodes = n;
  };
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
  selected: '--node-selected',
  outline: '--node-outline',
  iconOnAnchor: '--node-icon-on-anchor',
  iconOnCiting: '--node-icon-on-citing',
  iconOnCited: '--node-icon-on-cited',
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
 * painting it on a 1x1 canvas and reading the pixel back. Falls back to the input where
 * canvas isn't available (e.g. jsdom).
 */
function createColorNormalizer() {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext?.('2d', { willReadFrequently: true });
  if (!ctx) return (color) => color;
  return (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
}

/**
 * Reads graph colors from CSS custom properties, and re-reads them when the theme changes.
 *
 * Tokens are often derived (`color-mix()` of palette variables), and reading a custom property
 * returns that unevaluated text. So each token is applied to a hidden probe element, the
 * browser computes it, and the result is normalized to rgba() for the canvas.
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
  counts,
  years,
  visible,
  selectedId,
  onSelect,
  building = false,
  axisAngle = DEFAULT_AXIS_ANGLE,
}) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const { width, height } = useElementSize(containerRef);
  const colors = useThemeColors(containerRef);
  const geometry = useMemo(() => axisGeometry(axisAngle), [axisAngle]);
  // The year force runs outside React, so it reads the current geometry from a ref.
  const geometryRef = useRef(geometry);

  // force-graph stores positions on node objects, so reuse them across updates to keep the
  // layout stable as works are added.
  const [nodeCache] = useState(() => new Map());
  const positions = useMemo(
    () =>
      yearPositions(
        [...years.values()].map((y) => y.year).filter((y) => y != null),
        YEAR_SPACING,
      ),
    [years],
  );
  const data = useMemo(() => {
    for (const id of nodeCache.keys()) if (!graph.works.has(id)) nodeCache.delete(id);
    const nodes = [...graph.works.values()].map((work) => {
      let node = nodeCache.get(work.id);
      const year = years.get(work.id)?.year;
      const targetU = year == null ? null : positions.get(year);
      if (!node) {
        // Start new works at their year, so they don't fly across the graph to get there.
        node = { id: work.id, ...geometry.fromUV(targetU ?? 0, jitter(work.id) * 60) };
        nodeCache.set(work.id, node);
      }
      node.work = work;
      node.relation = graph.relations.get(work.id);
      node.val = nodeVal(counts.get(work.id) ?? 0);
      node.targetU = targetU;
      return node;
    });
    return { nodes, links: deriveEdges(graph.works) };
  }, [graph, counts, years, positions, nodeCache, geometry]);

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
      yearForce(() => geometryRef.current, YEAR_PULL, ACROSS_PULL),
    );
    fg.d3Force(
      'collide',
      forceCollide((node) => radiusOf(node.val) + COLLIDE_PADDING),
    );
    // Citations always join works from different years, so a strong link force would fight
    // the time axis. Keep links weak; they only loosely group related works across it.
    fg.d3Force('link').strength(0.02);
    // Limit repulsion to nearby works: otherwise many works on one side (e.g. all the works
    // citing the anchor) push a node off its year.
    fg.d3Force('charge').strength(CHARGE).distanceMax(CHARGE_RANGE);
    fg.d3ReheatSimulation();
  }, [ready]);

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
  }, [data, visible]);

  // Fit the view once the first layout settles after a new anchor.
  const fittedAnchor = useRef(null);
  const handleEngineStop = () => {
    // Wait for the whole build: the graph arrives in stages, and fitting to an early stage
    // (say, just the anchor) leaves the view zoomed in on a small part of the time axis.
    if (building || !graph.anchorId || fittedAnchor.current === graph.anchorId) return;
    fittedAnchor.current = graph.anchorId;
    graphRef.current?.zoomToFit(400, 40);
  };

  // When a build finishes, restart the simulation so it settles once more and fits the view
  // above; the last progress update may already have settled.
  useEffect(() => {
    if (!building && graph.anchorId && fittedAnchor.current !== graph.anchorId) {
      graphRef.current?.d3ReheatSimulation();
    }
  }, [building, graph.anchorId]);

  const endId = (end) => (typeof end === 'object' ? end.id : end);
  const isActiveLink = (link) =>
    selectedId != null && (endId(link.source) === selectedId || endId(link.target) === selectedId);

  const paintNode = (node, ctx, scale) => {
    const r = radiusOf(node.val);
    const isSelected = node.id === selectedId;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = colors[node.relation] ?? colors.cited;
    ctx.fill();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = colors.outline;
    ctx.stroke();
    if (isSelected) {
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = colors.selected;
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
      ctx.strokeStyle =
        node.relation === 'anchor'
          ? colors.iconOnAnchor
          : node.relation === 'citing'
            ? colors.iconOnCiting
            : colors.iconOnCited;
      ctx.stroke(icon);
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
              `${node.work.title ?? 'Untitled'}${node.work.year ? ` (${node.work.year})` : ''}`,
            )
          }
          nodeVisibility={(node) => visible.has(node.id)}
          linkVisibility={(link) =>
            visible.has(endId(link.source)) && visible.has(endId(link.target))
          }
          nodeCanvasObject={paintNode}
          nodePointerAreaPaint={paintPointerArea}
          linkColor={(link) => (isActiveLink(link) ? colors.linkActive : colors.link)}
          linkWidth={(link) => (isActiveLink(link) ? 1.5 : 0.5)}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={1}
          onNodeClick={(node) => onSelect(node.id)}
          onBackgroundClick={() => onSelect(null)}
          onEngineStop={handleEngineStop}
          onRenderFramePre={paintYearAxis}
          cooldownTicks={150}
        />
      )}
    </div>
  );
}

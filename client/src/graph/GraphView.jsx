import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { deriveEdges } from './graphModel.js';

const NODE_REL_SIZE = 4;

/** Circle area grows with in-graph citations: radius = relSize * sqrt(1 + count). */
const nodeVal = (count) => 1 + count;
const radiusOf = (val) => NODE_REL_SIZE * Math.sqrt(val);

const COLOR_VARS = {
  root: '--node-root',
  citing: '--node-citing',
  cited: '--node-cited',
  selected: '--node-selected',
  link: '--graph-link',
  linkActive: '--graph-link-active',
  label: '--text',
  labelBg: '--surface',
};

/** Reads graph colors from CSS custom properties, and re-reads them when the theme changes. */
function useThemeColors(ref) {
  const [colors, setColors] = useState(null);
  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(ref.current ?? document.documentElement);
      setColors(
        Object.fromEntries(
          Object.entries(COLOR_VARS).map(([key, name]) => [
            key,
            style.getPropertyValue(name).trim(),
          ]),
        ),
      );
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
 * Every work stays in the simulation; filtered-out works are only hidden (nodeVisibility),
 * so filtering doesn't reshuffle the layout.
 */
export default function GraphView({ graph, counts, visible, selectedId, onSelect }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const { width, height } = useElementSize(containerRef);
  const colors = useThemeColors(containerRef);

  // force-graph stores positions on node objects, so reuse them across updates to keep the
  // layout stable as works are added.
  const [nodeCache] = useState(() => new Map());
  const data = useMemo(() => {
    for (const id of nodeCache.keys()) if (!graph.works.has(id)) nodeCache.delete(id);
    const nodes = [...graph.works.values()].map((work) => {
      const node = nodeCache.get(work.id) ?? { id: work.id };
      node.work = work;
      node.relation = graph.relations.get(work.id);
      node.val = nodeVal(counts.get(work.id) ?? 0);
      nodeCache.set(work.id, node);
      return node;
    });
    return { nodes, links: deriveEdges(graph.works) };
  }, [graph, counts, nodeCache]);

  // Fit the view once the first layout settles after a new root.
  const fittedRoot = useRef(null);
  const handleEngineStop = () => {
    if (graph.rootId && fittedRoot.current !== graph.rootId) {
      fittedRoot.current = graph.rootId;
      graphRef.current?.zoomToFit(400, 40);
    }
  };

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
    if (isSelected) {
      ctx.lineWidth = 3 / scale;
      ctx.strokeStyle = colors.selected;
      ctx.stroke();
    }

    // Label the root and selection always, other works once zoomed in enough to read them.
    const showLabel = isSelected || node.relation === 'root' || scale > 2.5;
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
          nodeRelSize={NODE_REL_SIZE}
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
          cooldownTicks={150}
        />
      )}
    </div>
  );
}

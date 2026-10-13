import mongoose from 'mongoose';
import { SavedGraph } from '../models/SavedGraph.js';
import { HttpError } from '../works/errors.js';

export const MAX_NAME_LENGTH = 120;
export const MAX_GRAPHS_PER_USER = 500;
const MAX_EXPANDED = 5000;

// Allowed ranges for build options, as in the client's URL handling (urlState.js).
const OPTION_RANGES = {
  citingDepth: [0, 3],
  citedDepth: [0, 3],
  limit: [1, 200],
  maxNodes: [10, 2000],
};

const isInt = (value) => Number.isInteger(value);
const bad = (message) => new HttpError(400, message);

/**
 * The parts of a graph to save, checked and trimmed to what's stored. Throws 400 if anything
 * is missing or out of range.
 *
 * @param {any} state  { anchor: { id, ref?, title? }, options, filters, view, expanded }
 */
export function checkState(state) {
  if (!state || typeof state !== 'object') throw bad('Missing graph');
  const { anchor, options, filters = {}, view = {}, expanded = [] } = state;
  if (typeof anchor?.id !== 'string' || !anchor.id || anchor.id.length > 64) {
    throw bad('Missing anchor');
  }
  const checkedOptions = {};
  for (const [key, [min, max]] of Object.entries(OPTION_RANGES)) {
    const value = options?.[key];
    if (!isInt(value) || value < min || value > max) throw bad(`Invalid option: ${key}`);
    checkedOptions[key] = value;
  }
  const year = (value) => {
    if (value == null) return null;
    if (!isInt(value)) throw bad('Invalid year filter');
    return value;
  };
  const minConnections = filters.minConnections ?? 1;
  if (!isInt(minConnections) || minConnections < 0) throw bad('Invalid connections filter');
  const excludedTypes = filters.excludedTypes ?? [];
  if (
    !Array.isArray(excludedTypes) ||
    excludedTypes.length > 100 ||
    !excludedTypes.every((t) => typeof t === 'string' && t.length <= 64)
  ) {
    throw bad('Invalid type filter');
  }
  const axisAngle = view.axisAngle ?? null;
  if (axisAngle != null && (typeof axisAngle !== 'number' || axisAngle < 0 || axisAngle > 90)) {
    throw bad('Invalid axis angle');
  }
  if (
    !Array.isArray(expanded) ||
    expanded.length > MAX_EXPANDED ||
    !expanded.every((id) => typeof id === 'string' && id.length <= 64)
  ) {
    throw bad('Invalid expanded works');
  }
  return {
    anchor: {
      id: anchor.id,
      ref: typeof anchor.ref === 'string' ? anchor.ref.slice(0, 256) : null,
      title: typeof anchor.title === 'string' ? anchor.title.slice(0, 500) : null,
    },
    options: checkedOptions,
    filters: {
      minYear: year(filters.minYear),
      maxYear: year(filters.maxYear),
      minConnections,
      excludedTypes,
    },
    view: { axisAngle },
    expanded: [...new Set(expanded)],
  };
}

/** A trimmed name, or the anchor's title (or a placeholder) when it's blank. */
function checkName(name, fallback) {
  if (name != null && typeof name !== 'string') throw bad('Invalid name');
  const trimmed = (name ?? '').trim();
  if (trimmed.length > MAX_NAME_LENGTH)
    throw bad(`Use a name of at most ${MAX_NAME_LENGTH} characters`);
  return trimmed || (fallback ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled graph';
}

const summary = (graph) => ({
  id: String(graph._id),
  name: graph.name,
  anchor: { title: graph.anchor?.title ?? null, ref: graph.anchor?.ref ?? null },
  expandedCount: graph.expanded?.length ?? 0,
  createdAt: graph.createdAt,
  updatedAt: graph.updatedAt,
});

const full = (graph) => ({
  ...summary(graph),
  anchor: graph.anchor,
  options: graph.options,
  filters: graph.filters,
  view: graph.view,
  expanded: graph.expanded,
  annotations: (graph.annotations ?? []).map(
    ({ _id, target, kind, body, createdAt, updatedAt }) => ({
      id: String(_id),
      target,
      kind,
      body,
      createdAt,
      updatedAt,
    }),
  ),
});

/**
 * Saved graphs, each owned by one user. Every lookup is by owner and ID, so one user can't
 * read or change another's graphs (theirs simply aren't found).
 */
export function createGraphService() {
  /** The user's graph with this ID, or a 404. */
  async function owned(userId, id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Saved graph not found');
    const graph = await SavedGraph.findOne({ _id: id, userId }).exec();
    if (!graph) throw new HttpError(404, 'Saved graph not found');
    return graph;
  }

  return {
    /** The user's saved graphs, most recently changed first. */
    async list(userId) {
      const graphs = await SavedGraph.find({ userId }, { annotations: 0 })
        .sort({ updatedAt: -1 })
        .lean()
        .exec();
      return graphs.map(summary);
    },

    async create(userId, { name, state }) {
      const checked = checkState(state);
      if ((await SavedGraph.countDocuments({ userId })) >= MAX_GRAPHS_PER_USER) {
        throw new HttpError(403, `You can save up to ${MAX_GRAPHS_PER_USER} graphs`);
      }
      const graph = await SavedGraph.create({
        userId,
        name: checkName(name, checked.anchor.title),
        ...checked,
      });
      return full(graph);
    },

    async get(userId, id) {
      return full(await owned(userId, id));
    },

    /** Replaces what the graph holds (keeping its annotations), and its name if given. */
    async update(userId, id, { name, state }) {
      const graph = await owned(userId, id);
      graph.set(checkState(state));
      if (name !== undefined) graph.name = checkName(name, graph.anchor.title);
      await graph.save();
      return full(graph);
    },

    async rename(userId, id, name) {
      const graph = await owned(userId, id);
      graph.name = checkName(name, graph.anchor.title);
      await graph.save();
      return full(graph);
    },

    async remove(userId, id) {
      await owned(userId, id);
      await SavedGraph.deleteOne({ _id: id, userId });
    },
  };
}

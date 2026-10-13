import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import mongoose from 'mongoose';
import { GraphSnapshot } from '../models/GraphSnapshot.js';
import { SavedGraph } from '../models/SavedGraph.js';
import { HttpError } from '../works/errors.js';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const MAX_NAME_LENGTH = 120;
export const MAX_GRAPHS_PER_USER = 500;
const MAX_EXPANDED = 5000;
// How long a snapshot of a built graph is used before reopening the graph rebuilds it, so its
// works' data (citation counts, newly found citations) doesn't go stale for long.
export const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_WORKS = 20_000;
// Compressed. MongoDB's documents top out at 16 MB.
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const DIRECTIONS = new Set(['citing', 'cited']);
const RELATIONS = new Set(['anchor', 'citing', 'cited']);

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

/**
 * Identifies what a graph is built from: its anchor, build options and expansions (not its
 * filters or view, which don't change the works). A snapshot built from one key doesn't apply
 * to another.
 *
 * @param {{ anchor: { id: string }, options: object, expanded: string[] }} state
 */
export function stateKey({ anchor, options, expanded }) {
  const { citingDepth, citedDepth, limit, maxNodes } = options;
  return createHash('sha256')
    .update(JSON.stringify([anchor.id, citingDepth, citedDepth, limit, maxNodes, [...expanded]]))
    .digest('base64url');
}

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;

/**
 * A built graph as the client serializes it, checked for shape (the works themselves are only
 * ever shown to their owner, so they're stored as sent). Throws 400 if it's malformed or of a
 * different anchor.
 *
 * @param {any} snapshot  { anchorId, works, relations: [id, relation][],
 *   expanded: [id, direction[]][], sticky: id[], truncated }
 * @param {string} anchorId  The saved graph's anchor.
 */
export function checkSnapshot(snapshot, anchorId) {
  if (!snapshot || typeof snapshot !== 'object') throw bad('Invalid snapshot');
  const { works, relations, expanded, sticky, truncated } = snapshot;
  if (snapshot.anchorId !== anchorId) throw bad('Snapshot is of a different anchor');
  if (
    !Array.isArray(works) ||
    works.length > MAX_SNAPSHOT_WORKS ||
    !works.every((work) => work && typeof work === 'object' && isId(work.id)) ||
    !works.some((work) => work.id === anchorId)
  ) {
    throw bad('Invalid snapshot works');
  }
  const pairs = (list, valid) =>
    Array.isArray(list) &&
    list.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && isId(entry[0]) && valid(entry[1]),
    );
  if (!pairs(relations, (relation) => RELATIONS.has(relation)))
    throw bad('Invalid snapshot relations');
  const directions = (list) => Array.isArray(list) && list.every((d) => DIRECTIONS.has(d));
  if (!pairs(expanded, directions)) throw bad('Invalid snapshot expansions');
  if (!Array.isArray(sticky) || !sticky.every(isId)) throw bad('Invalid snapshot sticky works');
  return { anchorId, works, relations, expanded, sticky, truncated: truncated === true };
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
  stateKey: stateKey(graph),
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
export function createGraphService({
  now = () => Date.now(),
  snapshotTtlMs = SNAPSHOT_TTL_MS,
} = {}) {
  /** The user's graph with this ID, or a 404. */
  async function owned(userId, id) {
    if (!mongoose.isValidObjectId(id)) throw new HttpError(404, 'Saved graph not found');
    const graph = await SavedGraph.findOne({ _id: id, userId }).exec();
    if (!graph) throw new HttpError(404, 'Saved graph not found');
    return graph;
  }

  /** Stores a checked snapshot of `graph` as built from its current state. */
  async function storeSnapshot(graph, snapshot) {
    const data = await gzip(JSON.stringify(snapshot));
    if (data.length > MAX_SNAPSHOT_BYTES) throw new HttpError(413, 'Graph too large to cache');
    const builtAt = new Date(now());
    await GraphSnapshot.replaceOne(
      { _id: graph._id },
      {
        userId: graph.userId,
        key: stateKey(graph),
        data,
        builtAt,
        expiresAt: new Date(builtAt.getTime() + snapshotTtlMs),
      },
      { upsert: true },
    );
  }

  /** The graph's snapshot, if one is fresh and built from its current state; otherwise null. */
  async function freshSnapshot(graph) {
    const found = await GraphSnapshot.findOne({
      _id: graph._id,
      key: stateKey(graph),
      expiresAt: { $gt: new Date(now()) },
    }).exec();
    if (!found) return null;
    return JSON.parse((await gunzip(found.data)).toString('utf8'));
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

    /** Saves a graph, with a snapshot of it as built if one is given. */
    async create(userId, { name, state, snapshot }) {
      const checked = checkState(state);
      const checkedSnapshot = snapshot == null ? null : checkSnapshot(snapshot, checked.anchor.id);
      if ((await SavedGraph.countDocuments({ userId })) >= MAX_GRAPHS_PER_USER) {
        throw new HttpError(403, `You can save up to ${MAX_GRAPHS_PER_USER} graphs`);
      }
      const graph = await SavedGraph.create({
        userId,
        name: checkName(name, checked.anchor.title),
        ...checked,
      });
      if (checkedSnapshot) await storeSnapshot(graph, checkedSnapshot);
      return full(graph);
    },

    /**
     * The graph, with `snapshot`: the graph as last built, if that was within the snapshot TTL
     * and from its current state, or null when the client has to build it.
     */
    async get(userId, id) {
      const graph = await owned(userId, id);
      return { ...full(graph), snapshot: await freshSnapshot(graph) };
    },

    /**
     * Replaces what the graph holds (keeping its annotations), and its name if given. A snapshot
     * replaces the stored one; without one, a snapshot of the old state is dropped.
     */
    async update(userId, id, { name, state, snapshot }) {
      const graph = await owned(userId, id);
      const before = stateKey(graph);
      const checked = checkState(state);
      const checkedSnapshot = snapshot == null ? null : checkSnapshot(snapshot, checked.anchor.id);
      graph.set(checked);
      if (name !== undefined) graph.name = checkName(name, graph.anchor.title);
      await graph.save();
      if (checkedSnapshot) await storeSnapshot(graph, checkedSnapshot);
      else if (stateKey(graph) !== before) await GraphSnapshot.deleteOne({ _id: graph._id });
      return full(graph);
    },

    /**
     * Stores the graph as just built from the state identified by `key` (the `stateKey` the
     * client opened). Refused with a 409 if the graph has since been saved with another state.
     */
    async saveSnapshot(userId, id, { key, snapshot }) {
      const graph = await owned(userId, id);
      if (key !== stateKey(graph)) throw new HttpError(409, 'The saved graph has changed');
      await storeSnapshot(graph, checkSnapshot(snapshot, graph.anchor.id));
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
      await GraphSnapshot.deleteOne({ _id: id });
    },
  };
}

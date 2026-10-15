import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import mongoose from 'mongoose';
import { EntitlementError } from '../entitlements/entitlements.js';
import { PLANS } from '../entitlements/plans.js';
import { GraphSnapshot } from '../models/GraphSnapshot.js';
import { SavedGraph } from '../models/SavedGraph.js';
import { HttpError } from '../works/errors.js';
import { canonicalIdMap } from '../works/merges.js';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

export const MAX_NAME_LENGTH = 120;
const MAX_EXPANDED = 5000;
// The most anchors any plan allows (see entitlements/plans.js).
const MAX_ANCHORS = 6;
const MAX_ANNOTATIONS = 5000;
const MAX_NOTE_LENGTH = 10_000;
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

// Which plan limit (entitlements/plans.js) caps each build option.
const OPTION_LIMITS = {
  citingDepth: 'depth',
  citedDepth: 'depth',
  limit: 'perNode',
  maxNodes: 'maxNodes',
};

const isInt = (value) => Number.isInteger(value);
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 64;
const bad = (message) => new HttpError(400, message);

/**
 * The parts of a graph to save, checked and trimmed to what's stored. Throws 400 if anything
 * is missing or out of range.
 *
 * `annotations` is optional: without it, an update keeps the graph's annotations.
 *
 * Options beyond the user's plan limits (`limits`) are a 403.
 *
 * @param {any} state  { anchors: [{ id, ref?, title? }], options, filters,
 *   view: { axisAngle, pinned }, expanded, annotations? }. A single `anchor` (from a client
 *   from before multiple anchors) is read as `anchors: [anchor]`.
 * @param {Record<string, number>} [limits]  The user's plan limits (entitlementsFor).
 */
export function checkState(state, limits = PLANS.free.limits) {
  if (!state || typeof state !== 'object') throw bad('Missing graph');
  const { options, filters = {}, view = {}, expanded = [] } = state;
  const anchors = state.anchors ?? (state.anchor ? [state.anchor] : []);
  if (
    !Array.isArray(anchors) ||
    anchors.length === 0 ||
    !anchors.every((anchor) => isId(anchor?.id))
  ) {
    throw bad('Missing anchor');
  }
  if (anchors.length > MAX_ANCHORS || new Set(anchors.map((a) => a.id)).size < anchors.length) {
    throw bad('Invalid anchors');
  }
  if (anchors.length > limits.anchors) {
    throw new EntitlementError(`Your plan allows up to ${limits.anchors} anchors`, {
      limit: 'anchors',
    });
  }
  const checkedOptions = {};
  for (const [key, [min, max]] of Object.entries(OPTION_RANGES)) {
    const value = options?.[key];
    if (!isInt(value) || value < min || value > max) throw bad(`Invalid option: ${key}`);
    const limit = OPTION_LIMITS[key];
    if (value > limits[limit]) {
      throw new EntitlementError(`Your plan allows at most ${limits[limit]} (${key})`, { limit });
    }
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
  const pinned = view.pinned ?? [];
  if (
    !Array.isArray(pinned) ||
    pinned.length > MAX_EXPANDED ||
    !pinned.every((id) => typeof id === 'string' && id.length <= 64)
  ) {
    throw bad('Invalid pinned works');
  }
  if (
    !Array.isArray(expanded) ||
    expanded.length > MAX_EXPANDED ||
    !expanded.every((id) => typeof id === 'string' && id.length <= 64)
  ) {
    throw bad('Invalid expanded works');
  }
  const checked = {
    anchors: anchors.map((anchor) => ({
      id: anchor.id,
      ref: typeof anchor.ref === 'string' ? anchor.ref.slice(0, 256) : null,
      title: typeof anchor.title === 'string' ? anchor.title.slice(0, 500) : null,
    })),
    options: checkedOptions,
    filters: {
      minYear: year(filters.minYear),
      maxYear: year(filters.maxYear),
      minConnections,
      excludedTypes,
    },
    view: { axisAngle, pinned: [...new Set(pinned)] },
    expanded: [...new Set(expanded)],
  };
  if (state.annotations !== undefined) checked.annotations = checkAnnotations(state.annotations);
  return checked;
}

/**
 * Notes on the graph or its works: at most one per target (the last given wins), blank ones
 * dropped. Throws 400 if any is malformed.
 *
 * @param {any} annotations  [{ target: { type: 'graph' } | { type: 'work', workId }, kind:
 *   'note', body }]
 */
export function checkAnnotations(annotations) {
  if (!Array.isArray(annotations) || annotations.length > MAX_ANNOTATIONS) {
    throw bad('Invalid notes');
  }
  const byTarget = new Map();
  for (const annotation of annotations) {
    const { target, kind, body } = annotation ?? {};
    const work = target?.type === 'work';
    if (
      (!work && target?.type !== 'graph') ||
      (work && !isId(target.workId)) ||
      kind !== 'note' ||
      typeof body !== 'string'
    ) {
      throw bad('Invalid notes');
    }
    if (body.length > MAX_NOTE_LENGTH) {
      throw bad(`Use notes of at most ${MAX_NOTE_LENGTH.toLocaleString('en')} characters`);
    }
    const key = work ? `work:${target.workId}` : 'graph';
    byTarget.delete(key);
    if (body.trim()) {
      byTarget.set(key, {
        target: work ? { type: 'work', workId: target.workId } : { type: 'graph' },
        kind,
        body,
      });
    }
  }
  return [...byTarget.values()];
}

/**
 * The graph's annotations replaced by `next`, keeping unchanged ones as they were (with their
 * IDs and timestamps) and updating in place those whose body changed.
 */
function replaceAnnotations(graph, next) {
  const key = ({ target, kind }) => `${kind}:${target.type}:${target.workId ?? ''}`;
  const existing = new Map(graph.annotations.map((a) => [key(a), a]));
  graph.annotations = next.map((annotation) => {
    const found = existing.get(key(annotation));
    if (!found) return annotation;
    if (found.body !== annotation.body) found.body = annotation.body;
    return found;
  });
}

/**
 * A saved graph's anchors, primary first, as plain { id, ref, title }: `anchors`, or a version
 * 1 graph's single `anchor`.
 *
 * @param {{ anchors?: object[], anchor?: object }} graph
 */
export function anchorsOf(graph) {
  const list = graph.anchors?.length ? graph.anchors : graph.anchor?.id ? [graph.anchor] : [];
  return list.map(({ id, ref, title }) => ({ id, ref: ref ?? null, title: title ?? null }));
}

/**
 * Identifies what a graph is built from: its anchors, build options and expansions (not its
 * filters or view, which don't change the works). A snapshot built from one key doesn't apply
 * to another. A graph with one anchor hashes as it did before multiple anchors, so snapshots
 * of version 1 graphs stay valid.
 *
 * @param {{ anchors?: { id: string }[], anchor?: { id: string }, options: object,
 *   expanded: string[] }} state
 */
export function stateKey(state) {
  const { citingDepth, citedDepth, limit, maxNodes } = state.options;
  const ids = anchorsOf(state).map((anchor) => anchor.id);
  const anchors = ids.length === 1 ? ids[0] : ids;
  return createHash('sha256')
    .update(
      JSON.stringify([anchors, citingDepth, citedDepth, limit, maxNodes, [...state.expanded]]),
    )
    .digest('base64url');
}

/**
 * A built graph as the client serializes it, checked for shape (the works themselves are only
 * ever shown to their owner, so they're stored as sent). Throws 400 if it's malformed or of
 * different anchors.
 *
 * @param {any} snapshot  { anchorIds, works, relations: [id, relation][],
 *   expanded: [id, direction[]][], sticky: id[], truncated }
 *   (or one `anchorId`, as clients from before multiple anchors send)
 * @param {string[]} anchorIds  The saved graph's anchors.
 */
export function checkSnapshot(snapshot, anchorIds) {
  if (!snapshot || typeof snapshot !== 'object') throw bad('Invalid snapshot');
  const { works, relations, expanded, sticky, truncated } = snapshot;
  const ids = snapshot.anchorIds ?? (snapshot.anchorId ? [snapshot.anchorId] : null);
  if (
    !Array.isArray(ids) ||
    ids.length !== anchorIds.length ||
    !ids.every((id, i) => id === anchorIds[i])
  ) {
    throw bad('Snapshot is of different anchors');
  }
  if (
    !Array.isArray(works) ||
    works.length > MAX_SNAPSHOT_WORKS ||
    !works.every((work) => work && typeof work === 'object' && isId(work.id)) ||
    !anchorIds.every((id) => works.some((work) => work.id === id))
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
  return { anchorIds, works, relations, expanded, sticky, truncated: truncated === true };
}

/**
 * The default name for a graph, from its anchors: one's title, two joined by "&", or the
 * first and how many more, titles shortened to fit (as the client names it).
 */
function anchorsName(anchors) {
  const titles = anchors.map((anchor) => anchor.title || 'Untitled');
  const short = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  if (titles.length <= 1) return titles[0] ?? null;
  if (titles.length === 2) return `${short(titles[0], 58)} & ${short(titles[1], 58)}`;
  return `${short(titles[0], 100)} and ${titles.length - 1} more`;
}

/** A trimmed name, or the anchors' titles (or a placeholder) when it's blank. */
function checkName(name, fallback) {
  if (name != null && typeof name !== 'string') throw bad('Invalid name');
  const trimmed = (name ?? '').trim();
  if (trimmed.length > MAX_NAME_LENGTH)
    throw bad(`Use a name of at most ${MAX_NAME_LENGTH} characters`);
  return trimmed || (fallback ?? '').trim().slice(0, MAX_NAME_LENGTH) || 'Untitled graph';
}

const unique = (values) => [...new Set(values)];

/**
 * Rewrites the Tracer IDs `graph` (a SavedGraph document) stores, its anchors, expansions,
 * pins and note targets, to the works they were merged into, if any were (see
 * works/merges.js). Two IDs that became one are kept once (the first), and two notes on them
 * are joined. Returns whether anything changed.
 *
 * @param {(ids: string[]) => Promise<Map<string, string>>} resolveIds
 */
async function redirectMerged(graph, resolveIds) {
  const anchors = anchorsOf(graph);
  const pinned = graph.view?.pinned ?? [];
  const notes = graph.annotations.filter((a) => a.target?.type === 'work');
  const redirects = await resolveIds([
    ...anchors.map((anchor) => anchor.id),
    ...graph.expanded,
    ...pinned,
    ...notes.map((note) => note.target.workId),
  ]);
  if (redirects.size === 0) return false;
  const to = (id) => redirects.get(id) ?? id;
  const anchorIds = new Set();
  graph.anchors = anchors
    .map((anchor) => ({ ...anchor, id: to(anchor.id) }))
    .filter((anchor) => !anchorIds.has(anchor.id) && anchorIds.add(anchor.id));
  graph.anchor = undefined;
  graph.version = 2;
  graph.expanded = unique(graph.expanded.map(to));
  graph.set('view.pinned', unique(pinned.map(to)));
  const byWork = new Map();
  graph.annotations = graph.annotations.filter((annotation) => {
    if (annotation.target?.type !== 'work') return true;
    const workId = to(annotation.target.workId);
    const first = byWork.get(workId);
    if (first) {
      first.body = `${first.body}\n\n${annotation.body}`.slice(0, MAX_NOTE_LENGTH);
      return false;
    }
    annotation.target.workId = workId;
    byWork.set(workId, annotation);
    return true;
  });
  return true;
}

const summary = (graph) => ({
  id: String(graph._id),
  name: graph.name,
  anchors: anchorsOf(graph).map(({ ref, title }) => ({ title, ref })),
  expandedCount: graph.expanded?.length ?? 0,
  createdAt: graph.createdAt,
  updatedAt: graph.updatedAt,
});

const full = (graph) => ({
  ...summary(graph),
  stateKey: stateKey(graph),
  anchors: anchorsOf(graph),
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
  resolveIds = canonicalIdMap,
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

    /**
     * Saves a graph, with a snapshot of it as built if one is given. `limits` are the user's
     * plan limits (entitlementsFor): how many graphs they can save, and the build options.
     */
    async create(userId, { name, state, snapshot }, { limits = PLANS.free.limits } = {}) {
      const checked = checkState(state, limits);
      const checkedSnapshot =
        snapshot == null
          ? null
          : checkSnapshot(
              snapshot,
              checked.anchors.map((anchor) => anchor.id),
            );
      if ((await SavedGraph.countDocuments({ userId })) >= limits.savedGraphs) {
        throw new EntitlementError(`You can save up to ${limits.savedGraphs} graphs`, {
          limit: 'savedGraphs',
        });
      }
      const graph = await SavedGraph.create({
        userId,
        name: checkName(name, anchorsName(checked.anchors)),
        ...checked,
      });
      if (checkedSnapshot) await storeSnapshot(graph, checkedSnapshot);
      return full(graph);
    },

    /**
     * The graph, with `snapshot`: the graph as last built, if that was within the snapshot TTL
     * and from its current state, or null when the client has to build it.
     *
     * Works merged since it was saved (see works/merges.js) are followed first: the stored IDs
     * are rewritten to the works they were merged into (without counting as a change to the
     * graph), and a snapshot holding a merged work is dropped, so the rebuild shows it once.
     */
    async get(userId, id) {
      const graph = await owned(userId, id);
      if (await redirectMerged(graph, resolveIds)) {
        await graph.save({ timestamps: false });
        await GraphSnapshot.deleteOne({ _id: graph._id });
      }
      let snapshot = await freshSnapshot(graph);
      if (snapshot && (await resolveIds(snapshot.works.map((work) => work.id))).size > 0) {
        await GraphSnapshot.deleteOne({ _id: graph._id });
        snapshot = null;
      }
      return { ...full(graph), snapshot };
    },

    /**
     * Replaces what the graph holds, and its name if given. Its annotations are replaced only
     * when the state includes them. A snapshot
     * replaces the stored one; without one, a snapshot of the old state is dropped. `limits`
     * are the user's plan limits, as for create.
     */
    async update(userId, id, { name, state, snapshot }, { limits = PLANS.free.limits } = {}) {
      const graph = await owned(userId, id);
      const before = stateKey(graph);
      const checked = checkState(state, limits);
      const checkedSnapshot =
        snapshot == null
          ? null
          : checkSnapshot(
              snapshot,
              checked.anchors.map((anchor) => anchor.id),
            );
      const { annotations, ...rest } = checked;
      graph.set(rest);
      if (annotations) replaceAnnotations(graph, annotations);
      // A version 1 graph becomes version 2: `anchors` replaces `anchor`.
      graph.anchor = undefined;
      graph.version = 2;
      if (name !== undefined) graph.name = checkName(name, anchorsName(anchorsOf(graph)));
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
      await storeSnapshot(
        graph,
        checkSnapshot(
          snapshot,
          anchorsOf(graph).map((anchor) => anchor.id),
        ),
      );
    },

    async rename(userId, id, name) {
      const graph = await owned(userId, id);
      graph.name = checkName(name, anchorsName(anchorsOf(graph)));
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

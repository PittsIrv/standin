import { Gap, newId, ROOTS, Topic, TopicEdge, type EdgeKind, type EntityKind, type Memory, type MemoryKind, type MemoryStatus, type RootKey, type Tier } from "@standin/schema";
import { CycleError, NameTakenError, NotFoundError, RootEditError } from "./errors.ts";
import { normalizeName } from "./text.ts";
import { rowToMemory } from "./memories.ts";
import { rowToEntity, type Row } from "./rows.ts";
import type { Store } from "./store.ts";

function rowToTopic(r: Row): Topic {
  const e = rowToEntity(r);
  return Topic.parse({
    id: e.id,
    name: e.name,
    aliases: e.aliases,
    label: e.kind,
    rootKey: r.root_key ?? null,
    frontier: r.frontier === 1,
    partLevel: r.part_level ?? null,
    walkStopped: r.walk_stopped === 1,
    definition: r.definition ?? null,
    examples: JSON.parse(String(r.examples ?? "[]")),
    expandedAt: r.expanded_at ?? null,
    seedMemoryId: r.seed_memory_id ?? null,
    boundaryTier: r.boundary_tier ?? null,
    deletedAt: r.deleted_at ?? null,
  });
}

const rowToEdge = (r: Row): TopicEdge =>
  TopicEdge.parse({
    id: r.id,
    from: r.from_topic,
    to: r.to_topic,
    kind: r.kind,
    source: r.source,
    createdAt: r.created_at,
    deletedAt: r.deleted_at ?? null,
  });

const rowToGap = (r: Row): Gap =>
  Gap.parse({
    id: r.id,
    nodeId: r.node_id,
    claimNodeId: r.claim_node_id ?? null,
    level: r.level,
    status: r.status,
    source: r.source,
    memoryId: r.memory_id ?? null,
    responseId: r.response_id ?? null,
    createdAt: r.created_at,
  });

const TOPIC_SELECT =
  "SELECT e.*, t.definition, t.expanded_at, t.seed_memory_id, t.boundary_tier, t.deleted_at, t.root_key, t.frontier, t.part_level, t.walk_stopped, t.examples FROM entities e JOIN topics t ON t.entity_id = e.id";

/** The node for a name or alias with this label, created if absent. A deleted node is returned as it is (still deleted). */
export function ensureNode(s: Store, name: string, label: EntityKind, definition: string | null = null): Topic {
  return s.transaction(() => {
    const entity = s.resolveEntity({ name, kind: label });
    s.db.prepare("INSERT OR IGNORE INTO topics (entity_id, definition) VALUES (?, ?)").run(entity.id, definition);
    if (definition) s.db.prepare("UPDATE topics SET definition = COALESCE(definition, ?) WHERE entity_id = ?").run(definition, entity.id);
    return getTopic(s, entity.id);
  });
}

/** The six root nodes, in display order. */
export function roots(s: Store): Topic[] {
  return ROOTS.map((r) => root(s, r.key));
}

export function root(s: Store, key: RootKey): Topic {
  const r = s.db.prepare(`${TOPIC_SELECT} WHERE t.root_key = ?`).get(key) as Row | undefined;
  if (!r) throw new NotFoundError("root", key);
  return rowToTopic(r);
}

export function ensureTopic(s: Store, name: string, definition: string | null = null): Topic {
  return ensureNode(s, name, "topic", definition);
}

export function getTopic(s: Store, id: string): Topic {
  const r = s.db.prepare(`${TOPIC_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  if (!r) throw new NotFoundError("topic", id);
  return rowToTopic(r);
}

/** Every node except the six roots (see `roots()`); deleted nodes only on request. */
export function listTopics(s: Store, opts: { includeDeleted?: boolean; includeRoots?: boolean } = {}): Topic[] {
  const where = [opts.includeDeleted ? null : "t.deleted_at IS NULL", opts.includeRoots ? null : "t.root_key IS NULL"].filter(Boolean);
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return (s.db.prepare(`${TOPIC_SELECT} ${clause} ORDER BY e.name, e.id`).all() as Row[]).map(rowToTopic);
}

export function setTopic(
  s: Store,
  id: string,
  patch: {
    definition?: string;
    expandedAt?: string;
    seedMemoryId?: string;
    boundaryTier?: Tier | null;
    deletedAt?: string | null;
    frontier?: boolean;
    partLevel?: number | null;
    walkStopped?: boolean;
    examples?: string[];
  },
): Topic {
  getTopic(s, id);
  const cols: [string, unknown][] = [
    ["frontier", patch.frontier === undefined ? undefined : patch.frontier ? 1 : 0],
    ["walk_stopped", patch.walkStopped === undefined ? undefined : patch.walkStopped ? 1 : 0],
    ["part_level", patch.partLevel],
    ["definition", patch.definition],
    ["examples", patch.examples === undefined ? undefined : JSON.stringify(patch.examples)],
    ["expanded_at", patch.expandedAt],
    ["seed_memory_id", patch.seedMemoryId],
    ["boundary_tier", patch.boundaryTier],
    ["deleted_at", patch.deletedAt],
  ];
  for (const [col, value] of cols) if (value !== undefined) s.db.prepare(`UPDATE topics SET ${col} = ? WHERE entity_id = ?`).run(value as never, id);
  return getTopic(s, id);
}

const isLive = (s: Store, id: string) =>
  s.db.prepare("SELECT 1 FROM topics WHERE entity_id = ? AND deleted_at IS NULL").get(id) !== undefined;

/** Live edges between live topics. */
export function listEdges(s: Store, kind?: EdgeKind): TopicEdge[] {
  const rows = s.db
    .prepare(
      `SELECT g.* FROM topic_edges g
       JOIN topics a ON a.entity_id = g.from_topic AND a.deleted_at IS NULL
       JOIN topics b ON b.entity_id = g.to_topic AND b.deleted_at IS NULL
       WHERE g.deleted_at IS NULL AND (? IS NULL OR g.kind = ?) ORDER BY g.created_at, g.id`,
    )
    .all(kind ?? null, kind ?? null) as Row[];
  return rows.map(rowToEdge);
}

/** A path from `start` to `goal` over live edges of one kind, or null. */
function pathBetween(s: Store, kind: EdgeKind, start: string, goal: string): string[] | null {
  const next = new Map<string, string[]>();
  for (const e of listEdges(s, kind)) next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const walk = (node: string): string[] | null => {
    if (node === goal) return [node];
    if (seen.has(node)) return null;
    seen.add(node);
    for (const n of next.get(node) ?? []) {
      const rest = walk(n);
      if (rest) return [node, ...rest];
    }
    return null;
  };
  return walk(start);
}

const isRoot = (s: Store, id: string) => s.db.prepare("SELECT 1 FROM topics WHERE entity_id = ? AND root_key IS NOT NULL").get(id) !== undefined;

/** A node's one home parent (its live `part_of`), or null for a root or an unplaced node. */
export function homeParent(s: Store, id: string): string | null {
  const r = s.db
    .prepare(
      `SELECT g.to_topic FROM topic_edges g JOIN topics b ON b.entity_id = g.to_topic AND b.deleted_at IS NULL
       WHERE g.from_topic = ? AND g.kind = 'part_of' AND g.deleted_at IS NULL ORDER BY g.created_at, g.id LIMIT 1`,
    )
    .get(id) as Row | undefined;
  return r ? String(r.to_topic) : null;
}

/** The root a node lives under, following home parents; null while it is unplaced. */
export function rootOf(s: Store, id: string): RootKey | null {
  const seen = new Set<string>();
  for (let at: string | null = id; at && !seen.has(at); at = homeParent(s, at)) {
    seen.add(at);
    const r = s.db.prepare("SELECT root_key FROM topics WHERE entity_id = ?").get(at) as Row | undefined;
    if (r?.root_key) return r.root_key as RootKey;
  }
  return null;
}

/**
 * Adds an edge. Null when it already exists (or was deleted), touches a deleted node, would give a node a second home,
 * or would give a root a parent; CycleError if it closes a loop. `related` links are undirected: stored low id first.
 */
export function addEdge(s: Store, e: { from: string; to: string; kind: EdgeKind; source: TopicEdge["source"] }): TopicEdge | null {
  if (e.kind === "related" && e.from > e.to) e = { ...e, from: e.to, to: e.from };
  return s.transaction(() => {
    if (e.from === e.to || !isLive(s, e.from) || !isLive(s, e.to)) return null;
    if (s.db.prepare("SELECT 1 FROM topic_edges WHERE from_topic = ? AND to_topic = ? AND kind = ?").get(e.from, e.to, e.kind)) return null;
    if (e.kind === "part_of" && (isRoot(s, e.from) || homeParent(s, e.from) !== null)) return null;
    const loop = e.kind === "related" ? null : pathBetween(s, e.kind, e.to, e.from);
    if (loop) throw new CycleError([e.from, ...loop].map((id) => getTopic(s, id).name));
    const id = newId("edg");
    s.db
      .prepare("INSERT INTO topic_edges (id, from_topic, to_topic, kind, source, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, e.from, e.to, e.kind, e.source, s.nowIso());
    return rowToEdge(s.db.prepare("SELECT * FROM topic_edges WHERE id = ?").get(id) as Row);
  });
}

/** Folds `fromId` into `intoId`: aliases, memory links, edges and gaps move; the old topic is removed. */
export function mergeTopics(s: Store, fromId: string, intoId: string): void {
  s.transaction(() => {
    const from = getTopic(s, fromId);
    const into = getTopic(s, intoId);
    const aliases = [...new Set([...into.aliases, from.name, ...from.aliases])].filter((a) => a !== into.name);
    s.db.prepare("UPDATE entities SET aliases = ? WHERE id = ?").run(JSON.stringify(aliases), into.id);
    s.db.prepare("UPDATE OR IGNORE memory_entities SET entity_id = ? WHERE entity_id = ?").run(into.id, from.id);
    s.db.prepare("DELETE FROM memory_entities WHERE entity_id = ?").run(from.id);
    s.db.prepare("UPDATE OR IGNORE topic_edges SET from_topic = ? WHERE from_topic = ?").run(into.id, from.id);
    s.db.prepare("UPDATE OR IGNORE topic_edges SET to_topic = ? WHERE to_topic = ?").run(into.id, from.id);
    s.db.prepare("DELETE FROM topic_edges WHERE from_topic = ? OR to_topic = ? OR from_topic = to_topic").run(from.id, from.id);
    s.db.prepare("UPDATE OR IGNORE gaps SET node_id = ? WHERE node_id = ?").run(into.id, from.id);
    s.db.prepare("UPDATE gaps SET claim_node_id = ? WHERE claim_node_id = ?").run(into.id, from.id);
    s.db.prepare("DELETE FROM gaps WHERE node_id = ?").run(from.id);
    s.db.prepare("UPDATE probes SET node_id = ? WHERE node_id = ?").run(into.id, from.id);
    s.db.prepare("UPDATE memories SET home_node_id = ? WHERE home_node_id = ?").run(into.id, from.id);
    s.db.prepare("UPDATE probes SET check_of = ? WHERE check_of = ?").run(into.id, from.id);
    for (const kind of ["part_of", "requires"] as const) {
      for (const e of listEdges(s, kind)) {
        const loop = pathBetween(s, kind, e.to, e.from);
        if (loop) throw new CycleError([e.from, ...loop].map((id) => getTopic(s, id).name));
      }
    }
    s.db.prepare("DELETE FROM topics WHERE entity_id = ?").run(from.id);
    s.db.prepare("DELETE FROM entities WHERE id = ?").run(from.id);
  });
}

export type NewGap = Omit<Gap, "id" | "createdAt" | "responseId"> & { responseId?: string | null };

/** Null if this gap already exists: per stated memory, or per judged response. */
export function addGap(s: Store, g: NewGap): Gap | null {
  const responseId = g.responseId ?? null;
  const exists = responseId
    ? s.db.prepare("SELECT 1 FROM gaps WHERE response_id = ?").get(responseId)
    : s.db.prepare("SELECT 1 FROM gaps WHERE node_id = ? AND memory_id IS ? AND response_id IS NULL").get(g.nodeId, g.memoryId);
  if (exists) return null;
  const id = newId("gap");
  s.db
    .prepare("INSERT INTO gaps (id, node_id, claim_node_id, level, status, source, memory_id, response_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, g.nodeId, g.claimNodeId, g.level, g.status, g.source, g.memoryId, responseId, s.nowIso());
  return rowToGap(s.db.prepare("SELECT * FROM gaps WHERE id = ?").get(id) as Row);
}

export function setGap(s: Store, id: string, patch: { status?: Gap["status"]; level?: number }): Gap {
  if (patch.status !== undefined) s.db.prepare("UPDATE gaps SET status = ? WHERE id = ?").run(patch.status, id);
  if (patch.level !== undefined) s.db.prepare("UPDATE gaps SET level = ? WHERE id = ?").run(patch.level, id);
  const r = s.db.prepare("SELECT * FROM gaps WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("gap", id);
  return rowToGap(r);
}

export function listGaps(s: Store): Gap[] {
  return (s.db.prepare("SELECT * FROM gaps ORDER BY created_at, id").all() as Row[]).map(rowToGap);
}

/** Memories linked to a topic entity. */
export function topicMemories(s: Store, topicId: string, filter: { kind?: MemoryKind; status?: MemoryStatus } = {}): Memory[] {
  const rows = s.db
    .prepare(
      `SELECT m.* FROM memories m JOIN memory_entities me ON me.memory_id = m.id
       WHERE me.entity_id = ? AND (? IS NULL OR m.kind = ?) AND (? IS NULL OR m.status = ?)
       ORDER BY m.recorded_at, m.rowid`,
    )
    .all(topicId, filter.kind ?? null, filter.kind ?? null, filter.status ?? null, filter.status ?? null) as Row[];
  return rows.map(rowToMemory);
}

/** Memories whose home is this node. */
export function nodeMemories(s: Store, nodeId: string, filter: { status?: MemoryStatus } = {}): Memory[] {
  const rows = s.db
    .prepare("SELECT * FROM memories WHERE home_node_id = ? AND (? IS NULL OR status = ?) ORDER BY recorded_at, rowid")
    .all(nodeId, filter.status ?? null, filter.status ?? null) as Row[];
  return rows.map(rowToMemory);
}

const guardRoot = (s: Store, id: string) => {
  const t = getTopic(s, id);
  if (t.rootKey) throw new RootEditError(t.name);
  return t;
};

/** Renames a node; the old name stays as an alias. Refuses a name another node of the same label already answers to. */
export function renameTopic(s: Store, id: string, name: string): Topic {
  return s.transaction(() => {
    const t = guardRoot(s, id);
    const clean = name.trim().replace(/\s+/g, " ");
    if (!clean) throw new NameTakenError(name);
    const other = s.findEntity({ name: clean, kind: t.label });
    if (other && other.id !== id) throw new NameTakenError(name);
    const aliases = [...new Set([...t.aliases, t.name])].filter((a) => normalizeName(a) !== normalizeName(clean));
    s.db.prepare("UPDATE entities SET name = ?, aliases = ? WHERE id = ?").run(clean, JSON.stringify(aliases), id);
    s.db.prepare("UPDATE topics SET frontier = 0 WHERE entity_id = ?").run(id);
    return getTopic(s, id);
  });
}

/** The person describes a node: its definition and what it includes. Their words win over any split or seeding. */
export function describeTopic(s: Store, id: string, d: { definition: string | null; examples: string[] }): Topic {
  return s.transaction(() => {
    guardRoot(s, id);
    const examples = [...new Set(d.examples.map((e) => e.trim().replace(/\s+/g, " ")).filter(Boolean))];
    const definition = d.definition?.trim() || null;
    s.db.prepare("UPDATE topics SET definition = ?, examples = ?, frontier = 0 WHERE entity_id = ?").run(definition, JSON.stringify(examples), id);
    return getTopic(s, id);
  });
}

/** The person moves a node: its old home goes, the new one is theirs. A cycle leaves everything as it was. Null parent = unplaced. */
export function moveTopic(s: Store, id: string, parentId: string | null): TopicEdge | null {
  return s.transaction(() => {
    guardRoot(s, id);
    const now = s.nowIso();
    s.db.prepare("UPDATE topic_edges SET deleted_at = ? WHERE from_topic = ? AND kind = 'part_of' AND deleted_at IS NULL").run(now, id);
    s.db.prepare("UPDATE topics SET frontier = 0 WHERE entity_id = ?").run(id);
    if (parentId === null) return null;
    if (!isLive(s, parentId)) throw new NotFoundError("topic", parentId);
    const loop = pathBetween(s, "part_of", parentId, id);
    if (loop) throw new CycleError([id, ...loop].map((n) => getTopic(s, n).name));
    const existing = s.db.prepare("SELECT id FROM topic_edges WHERE from_topic = ? AND to_topic = ? AND kind = 'part_of'").get(id, parentId) as Row | undefined;
    const edgeId = existing ? String(existing.id) : newId("edg");
    if (existing) s.db.prepare("UPDATE topic_edges SET deleted_at = NULL, source = 'person', created_at = ? WHERE id = ?").run(now, edgeId);
    else
      s.db
        .prepare("INSERT INTO topic_edges (id, from_topic, to_topic, kind, source, created_at) VALUES (?, ?, ?, 'part_of', 'person', ?)")
        .run(edgeId, id, parentId, now);
    return rowToEdge(s.db.prepare("SELECT * FROM topic_edges WHERE id = ?").get(edgeId) as Row);
  });
}

/** Deletes an edge for good: no automatic step re-adds it. */
export function deleteEdge(s: Store, id: string): void {
  const r = s.db.prepare("SELECT deleted_at FROM topic_edges WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("edge", id);
  if (!r.deleted_at) s.db.prepare("UPDATE topic_edges SET deleted_at = ? WHERE id = ?").run(s.nowIso(), id);
}

/** Deletes a node for good. Memories that lived in it move up to its home parent (or become unplaced). */
export function deleteTopic(s: Store, id: string): Topic {
  return s.transaction(() => {
    guardRoot(s, id);
    s.db.prepare("UPDATE memories SET home_node_id = ? WHERE home_node_id = ?").run(homeParent(s, id), id);
    return setTopic(s, id, { deletedAt: s.nowIso() });
  });
}

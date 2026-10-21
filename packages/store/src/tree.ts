import { Gap, newId, Topic, TopicEdge, type EdgeKind, type Memory, type MemoryKind, type MemoryStatus, type Tier } from "@standin/schema";
import { CycleError, NotFoundError } from "./errors.ts";
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
    definition: r.definition ?? null,
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

const TOPIC_SELECT = "SELECT e.*, t.definition, t.expanded_at, t.seed_memory_id, t.boundary_tier, t.deleted_at FROM entities e JOIN topics t ON t.entity_id = e.id";

/** The topic for a name or alias, created if absent. A deleted topic is returned as it is (still deleted). */
export function ensureTopic(s: Store, name: string, definition: string | null = null): Topic {
  return s.transaction(() => {
    const entity = s.resolveEntity({ name, kind: "topic" });
    s.db.prepare("INSERT OR IGNORE INTO topics (entity_id, definition) VALUES (?, ?)").run(entity.id, definition);
    if (definition) s.db.prepare("UPDATE topics SET definition = COALESCE(definition, ?) WHERE entity_id = ?").run(definition, entity.id);
    return getTopic(s, entity.id);
  });
}

export function getTopic(s: Store, id: string): Topic {
  const r = s.db.prepare(`${TOPIC_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
  if (!r) throw new NotFoundError("topic", id);
  return rowToTopic(r);
}

export function listTopics(s: Store, opts: { includeDeleted?: boolean } = {}): Topic[] {
  const where = opts.includeDeleted ? "" : "WHERE t.deleted_at IS NULL";
  return (s.db.prepare(`${TOPIC_SELECT} ${where} ORDER BY e.name, e.id`).all() as Row[]).map(rowToTopic);
}

export function setTopic(
  s: Store,
  id: string,
  patch: { definition?: string; expandedAt?: string; seedMemoryId?: string; boundaryTier?: Tier | null; deletedAt?: string | null },
): Topic {
  getTopic(s, id);
  const cols: [string, unknown][] = [
    ["definition", patch.definition],
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

/** Adds an edge. Null when it already exists (or was deleted) or touches a deleted topic; CycleError if it closes a loop. */
export function addEdge(s: Store, e: { from: string; to: string; kind: EdgeKind; source: TopicEdge["source"] }): TopicEdge | null {
  return s.transaction(() => {
    if (e.from === e.to || !isLive(s, e.from) || !isLive(s, e.to)) return null;
    if (s.db.prepare("SELECT 1 FROM topic_edges WHERE from_topic = ? AND to_topic = ? AND kind = ?").get(e.from, e.to, e.kind)) return null;
    const loop = pathBetween(s, e.kind, e.to, e.from);
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

import {
  ALLOWED_TRANSITIONS,
  Memory,
  newId,
  type Actor,
  type Entity,
  type MemoryEvent,
  type MemoryKind,
  type MemoryStatus,
  type Observation,
  type Tier,
} from "@standin/schema";
import { computeConfidence } from "./confidence.ts";
import { AmbiguousIdError, InvalidTransitionError, NotFoundError } from "./errors.ts";
import { rowToEntity, rowToObservation, type Row } from "./rows.ts";
import type { Store } from "./store.ts";
import { dice } from "./text.ts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What callers supply to create a memory; lifecycle and scoring fields are owned by the store. */
export type NewMemory = DistributiveOmit<
  Memory,
  | "id"
  | "status"
  | "confidence"
  | "salience"
  | "affirmed"
  | "recordedAt"
  | "decidedAt"
  | "lastCorroboratedAt"
  | "validFrom"
  | "validUntil"
  | "supersedesId"
  | "conflictsWithId"
> & {
  validFrom?: string | null;
  validUntil?: string | null;
  supersedesId?: string | null;
  conflictsWithId?: string | null;
};

export interface InsertContext {
  sourceObservationIds: string[];
  entityIds: string[];
  actor: Actor;
  salience: number;
}

export interface Neighbor {
  memory: Memory;
  score: number;
}

/** Shared-entity matches always outrank purely textual ones (Dice similarity is at most 1). */
export const SHARED_ENTITY_BOOST = 1;

const canonicalIso = (s: string | null | undefined): string | null => (s ? new Date(s).toISOString() : null);

export function rowToMemory(r: Row): Memory {
  return Memory.parse({
    id: r.id,
    kind: r.kind,
    statement: r.statement,
    lang: r.lang,
    tier: r.tier,
    status: r.status,
    confidence: r.confidence,
    salience: r.salience,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    isCurrentState: r.is_current_state === 1,
    affirmed: r.affirmed === 1,
    supersedesId: r.supersedes_id,
    conflictsWithId: r.conflicts_with_id,
    recordedAt: r.recorded_at,
    decidedAt: r.decided_at,
    lastCorroboratedAt: r.last_corroborated_at,
    attrs: JSON.parse(String(r.attrs)),
  });
}

function rowToEvent(r: Row): MemoryEvent {
  return {
    id: String(r.id),
    memoryId: String(r.memory_id),
    fromStatus: (r.from_status as MemoryStatus | null) ?? null,
    toStatus: r.to_status as MemoryStatus,
    at: String(r.at),
    actor: r.actor as Actor,
    note: (r.note as string | null) ?? null,
  };
}

function writeEvent(s: Store, memoryId: string, from: MemoryStatus | null, to: MemoryStatus, actor: Actor, note: string | null): void {
  const { next } = s.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM memory_events").get() as { next: number };
  s.db
    .prepare("INSERT INTO memory_events (id, seq, memory_id, from_status, to_status, at, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(newId("evt"), next, memoryId, from, to, s.nowIso(), actor, note);
}

export function memorySources(s: Store, id: string): Observation[] {
  const rows = s.db
    .prepare(
      `SELECT o.* FROM observations o JOIN memory_sources ms ON ms.observation_id = o.id
       WHERE ms.memory_id = ? ORDER BY o.occurred_at, o.id`,
    )
    .all(id) as Row[];
  return rows.map(rowToObservation);
}

export function memoryEntities(s: Store, id: string): Entity[] {
  const rows = s.db
    .prepare("SELECT e.* FROM entities e JOIN memory_entities me ON me.entity_id = e.id WHERE me.memory_id = ? ORDER BY e.name")
    .all(id) as Row[];
  return rows.map(rowToEntity);
}

export function memoryEvents(s: Store, id: string): MemoryEvent[] {
  return (s.db.prepare("SELECT * FROM memory_events WHERE memory_id = ? ORDER BY seq").all(id) as Row[]).map(rowToEvent);
}

function confidenceFor(s: Store, m: Memory, halfLifeDays: number): number {
  const sources = memorySources(s, m.id).map((o) => ({ sourceKind: o.sourceKind, authorRole: o.authorRole }));
  return computeConfidence({
    affirmed: m.affirmed,
    sources,
    isCurrentState: m.isCurrentState,
    lastCorroboratedAt: m.lastCorroboratedAt,
    now: s.clock.now(),
    halfLifeDays,
  });
}

export function recomputeConfidence(s: Store, id: string, halfLifeDays = s.halfLifeDays): Memory {
  const m = getMemory(s, id);
  s.db.prepare("UPDATE memories SET confidence = ? WHERE id = ?").run(confidenceFor(s, m, halfLifeDays), m.id);
  return getMemory(s, m.id);
}

export function insertMemory(s: Store, input: NewMemory, ctx: InsertContext): Memory {
  return s.transaction(() => {
    const id = newId("mem");
    const now = s.nowIso();
    const validUntil = canonicalIso(input.validUntil);
    for (const obsId of ctx.sourceObservationIds) s.getObservation(obsId);
    s.db
      .prepare(
        `INSERT INTO memories (id, kind, statement, lang, tier, status, confidence, salience, valid_from, valid_until,
           original_valid_until, is_current_state, affirmed, supersedes_id, conflicts_with_id, recorded_at, decided_at,
           last_corroborated_at, attrs)
         VALUES (?, ?, ?, ?, ?, 'proposed', 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.statement.trim(),
        input.lang,
        input.tier,
        ctx.salience,
        canonicalIso(input.validFrom),
        validUntil,
        validUntil,
        input.isCurrentState ? 1 : 0,
        input.supersedesId ?? null,
        input.conflictsWithId ?? null,
        now,
        now,
        JSON.stringify(input.attrs),
      );
    const link = s.db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, observation_id) VALUES (?, ?)");
    for (const obsId of ctx.sourceObservationIds) link.run(id, obsId);
    const linkEntity = s.db.prepare("INSERT OR IGNORE INTO memory_entities (memory_id, entity_id) VALUES (?, ?)");
    for (const entId of ctx.entityIds) linkEntity.run(id, entId);
    writeEvent(s, id, null, "proposed", ctx.actor, null);
    return recomputeConfidence(s, id);
  });
}

export function addCorroboration(s: Store, memoryId: string, observationId: string): Memory {
  return s.transaction(() => {
    const m = getMemory(s, memoryId);
    s.getObservation(observationId);
    s.db.prepare("INSERT OR IGNORE INTO memory_sources (memory_id, observation_id) VALUES (?, ?)").run(m.id, observationId);
    s.db.prepare("UPDATE memories SET last_corroborated_at = ? WHERE id = ?").run(s.nowIso(), m.id);
    return recomputeConfidence(s, m.id);
  });
}

/** Exact id, or a unique prefix of at least 6 characters (the `mem_` prefix is optional). */
export function getMemory(s: Store, idOrPrefix: string): Memory {
  const exact = s.db.prepare("SELECT * FROM memories WHERE id = ?").get(idOrPrefix) as Row | undefined;
  if (exact) return rowToMemory(exact);
  const prefix = idOrPrefix.startsWith("mem_") ? idOrPrefix : `mem_${idOrPrefix}`;
  if (prefix.length < 10 || !/^mem_[0-9a-f]+$/.test(prefix)) throw new NotFoundError("memory", idOrPrefix);
  const rows = s.db.prepare("SELECT * FROM memories WHERE id LIKE ? ORDER BY id").all(`${prefix}%`) as Row[];
  if (rows.length === 0) throw new NotFoundError("memory", idOrPrefix);
  if (rows.length > 1) throw new AmbiguousIdError(idOrPrefix, rows.map((r) => String(r.id)));
  return rowToMemory(rows[0]!);
}

export function listMemories(s: Store, filter: { status?: MemoryStatus; kind?: MemoryKind } = {}): Memory[] {
  const rows = s.db
    .prepare(
      `SELECT * FROM memories WHERE (? IS NULL OR status = ?) AND (? IS NULL OR kind = ?)
       ORDER BY recorded_at, rowid`,
    )
    .all(filter.status ?? null, filter.status ?? null, filter.kind ?? null, filter.kind ?? null) as Row[];
  return rows.map(rowToMemory);
}

function assertTransition(m: Memory, to: MemoryStatus): void {
  if (!ALLOWED_TRANSITIONS[m.status].includes(to)) throw new InvalidTransitionError(m.id, m.status, to);
}

export function approve(s: Store, id: string, edits: { statement?: string; tier?: Tier } = {}): Memory {
  return s.transaction(() => {
    const m = getMemory(s, id);
    assertTransition(m, "approved");
    const now = s.nowIso();
    const notes: string[] = [];
    const statement = edits.statement?.trim() || m.statement;
    if (statement !== m.statement) notes.push(`statement "${m.statement}" → "${statement}"`);
    const tier = edits.tier ?? m.tier;
    if (tier !== m.tier) notes.push(`tier ${m.tier} → ${tier}`);

    const targets = [m.supersedesId, m.conflictsWithId].filter((t): t is string => t !== null).map((t) => getMemory(s, t));
    const liveTargets = targets.filter((t) => t.status === "approved");
    // A still-proposed target lost to this memory; reject it so the pair can't both end up approved.
    for (const t of targets.filter((t) => t.status === "proposed")) {
      s.db.prepare("UPDATE memories SET status = 'rejected', decided_at = ? WHERE id = ?").run(now, t.id);
      writeEvent(s, t.id, "proposed", "rejected", "person", `replaced by ${m.id}`);
    }
    const validFrom = m.validFrom ?? (liveTargets.length > 0 ? now : null);

    s.db
      .prepare(
        `UPDATE memories SET status = 'approved', statement = ?, tier = ?, affirmed = 1, decided_at = ?,
           last_corroborated_at = ?, valid_from = ?, original_valid_until = valid_until WHERE id = ?`,
      )
      .run(statement, tier, now, now, validFrom, m.id);
    writeEvent(s, m.id, "proposed", "approved", "person", notes.length > 0 ? notes.join("; ") : null);
    recomputeConfidence(s, m.id);

    for (const t of liveTargets) {
      s.db
        .prepare("UPDATE memories SET status = 'superseded', valid_until = COALESCE(valid_until, ?) WHERE id = ?")
        .run(validFrom ?? now, t.id);
      writeEvent(s, t.id, "approved", "superseded", "person", `superseded by ${m.id}`);
    }
    return getMemory(s, m.id);
  });
}

function simpleTransition(s: Store, id: string, to: MemoryStatus, actor: Actor, note: string | null): Memory {
  return s.transaction(() => {
    const m = getMemory(s, id);
    assertTransition(m, to);
    const now = s.nowIso();
    if (to === "rejected") s.db.prepare("UPDATE memories SET status = ?, decided_at = ? WHERE id = ?").run(to, now, m.id);
    else if (to === "expired")
      s.db.prepare("UPDATE memories SET status = ?, valid_until = COALESCE(valid_until, ?) WHERE id = ?").run(to, now, m.id);
    else s.db.prepare("UPDATE memories SET status = ? WHERE id = ?").run(to, m.id);
    writeEvent(s, m.id, m.status, to, actor, note);
    return getMemory(s, m.id);
  });
}

export const reject = (s: Store, id: string, note: string | null = null) => simpleTransition(s, id, "rejected", "person", note);
export const retract = (s: Store, id: string, note: string | null = null) => simpleTransition(s, id, "retracted", "person", note);
export const expire = (s: Store, id: string, note: string | null = null, actor: Actor = "consolidation") =>
  simpleTransition(s, id, "expired", actor, note);

export function findNeighbors(
  s: Store,
  query: { statement: string; entityIds: string[] },
  opts: { limit?: number; minSimilarity?: number } = {},
): Neighbor[] {
  const limit = opts.limit ?? 8;
  const minSimilarity = opts.minSimilarity ?? 0.3;
  const rows = s.db.prepare("SELECT * FROM memories WHERE status IN ('proposed', 'approved', 'rejected')").all() as Row[];
  const shared = new Set<string>();
  if (query.entityIds.length > 0) {
    const marks = query.entityIds.map(() => "?").join(", ");
    for (const r of s.db.prepare(`SELECT DISTINCT memory_id FROM memory_entities WHERE entity_id IN (${marks})`).all(...query.entityIds) as Row[])
      shared.add(String(r.memory_id));
  }
  return rows
    .map((r) => {
      const similarity = dice(query.statement, String(r.statement));
      const isShared = shared.has(String(r.id));
      return { row: r, keep: isShared || similarity >= minSimilarity, score: similarity + (isShared ? SHARED_ENTITY_BOOST : 0) };
    })
    .filter((x) => x.keep)
    .sort((a, b) => b.score - a.score || String(a.row.id).localeCompare(String(b.row.id)))
    .slice(0, limit)
    .map((x) => ({ memory: rowToMemory(x.row), score: x.score }));
}

/**
 * Bitemporal query: memories believed true at `validAt`, according to what was recorded by `recordedAt`.
 * Status is replayed from the event log; validity uses the bounds as they stood at that record time.
 */
export function memoriesAsOf(s: Store, q: { validAt: Date; recordedAt?: Date }): Memory[] {
  const recordedAt = (q.recordedAt ?? s.clock.now()).toISOString();
  const validAt = q.validAt.toISOString();
  const rows = s.db
    .prepare(
      `SELECT m.*, e.to_status AS status_then FROM memories m
       JOIN memory_events e ON e.memory_id = m.id
       WHERE e.seq = (SELECT MAX(e2.seq) FROM memory_events e2 WHERE e2.memory_id = m.id AND e2.at <= ?)
         AND e.to_status IN ('approved', 'superseded', 'expired')
       ORDER BY m.valid_from, m.recorded_at, m.id`,
    )
    .all(recordedAt) as Row[];
  return rows
    .filter((r) => {
      const until = (r.status_then === "approved" ? r.original_valid_until : r.valid_until) as string | null;
      const from = r.valid_from as string | null;
      return (from === null || from <= validAt) && (until === null || validAt < until);
    })
    .map(rowToMemory);
}

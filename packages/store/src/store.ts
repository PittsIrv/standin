import type { DatabaseSync } from "node:sqlite";
import {
  ObservationInput,
  newId,
  type CompactionResult,
  type Entity,
  type EntityKind,
  type Observation,
  type ObservationInput as ObservationInputT,
} from "@standin/schema";
import { openDatabase, systemClock, transaction, type Clock } from "./db.ts";
import { NotFoundError } from "./errors.ts";
import { rowToEntity, rowToObservation, type Row } from "./rows.ts";
import { contentHash, normalizeName, normalizeText } from "./text.ts";
import * as mem from "./memories.ts";
import * as exm from "./exemplars.ts";
import { consolidate, type ConsolidationReport } from "./consolidate.ts";
import type {
  Config,
  Exemplar,
  ExemplarStatus,
  Lang,
  Memory,
  MemoryEvent,
  MemoryKind,
  MemoryStatus,
  Register,
  Tier,
} from "@standin/schema";

export interface StoreOptions {
  path: string;
  clock?: Clock;
  /** Half-life used to decay current-state memories between consolidations. */
  currentStateHalfLifeDays?: number;
}

export function openStore(opts: StoreOptions): Store {
  return new Store(openDatabase(opts.path), opts.clock ?? systemClock, opts.currentStateHalfLifeDays ?? 90);
}

export class Store {
  constructor(
    readonly db: DatabaseSync,
    readonly clock: Clock,
    readonly halfLifeDays = 90,
  ) {}

  close(): void {
    this.db.close();
  }

  nowIso(): string {
    return this.clock.now().toISOString();
  }

  /** Runs `fn` atomically; nests as a savepoint inside an outer transaction. */
  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  // ---- observations -------------------------------------------------------

  /** Idempotent: identical content from the same source kind returns the existing observation. */
  addObservation(input: ObservationInputT): Observation {
    const o = ObservationInput.parse(input);
    const hash = contentHash(o.sourceKind, normalizeText(o.text));
    const existing = this.db.prepare("SELECT * FROM observations WHERE content_hash = ?").get(hash) as Row | undefined;
    if (existing) return rowToObservation(existing);
    const id = newId("obs");
    this.db
      .prepare(
        `INSERT INTO observations (id, source_kind, source_ref, author_role, lang, text, content_hash, occurred_at, ingested_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.sourceKind,
        o.sourceRef,
        o.authorRole,
        o.lang,
        o.text,
        hash,
        new Date(o.occurredAt).toISOString(),
        this.nowIso(),
        JSON.stringify(o.meta),
      );
    return this.getObservation(id);
  }

  getObservation(id: string): Observation {
    const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("observation", id);
    return rowToObservation(row);
  }

  uncompactedObservations(limit: number, opts: { retryFailed?: boolean } = {}): Observation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observations
         WHERE text IS NOT NULL AND (compacted_at IS NULL OR (? AND compaction_result = 'failed'))
         ORDER BY occurred_at, ingested_at, id
         LIMIT ?`,
      )
      .all(opts.retryFailed ? 1 : 0, limit) as Row[];
    return rows.map(rowToObservation);
  }

  markCompacted(id: string, result: CompactionResult): void {
    const r = this.db
      .prepare("UPDATE observations SET compacted_at = ?, compaction_result = ? WHERE id = ?")
      .run(this.nowIso(), result, id);
    if (r.changes === 0) throw new NotFoundError("observation", id);
  }

  // ---- entities -----------------------------------------------------------

  /** Finds an entity of the same kind by normalized name or alias, creating it if absent. */
  resolveEntity(input: { name: string; kind: EntityKind; aliases?: string[] }): Entity {
    const keys = new Set([input.name, ...(input.aliases ?? [])].map(normalizeName).filter(Boolean));
    const candidates = (this.db.prepare("SELECT * FROM entities WHERE kind = ?").all(input.kind) as Row[]).map(rowToEntity);
    for (const e of candidates) {
      if ([e.name, ...e.aliases].some((n) => keys.has(normalizeName(n)))) return e;
    }
    const id = newId("ent");
    this.db
      .prepare("INSERT INTO entities (id, kind, name, aliases) VALUES (?, ?, ?, ?)")
      .run(id, input.kind, input.name.trim(), JSON.stringify(input.aliases ?? []));
    return { id, kind: input.kind, name: input.name.trim(), aliases: input.aliases ?? [] };
  }

  getEntity(id: string): Entity {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("entity", id);
    return rowToEntity(row);
  }

  // ---- memories -----------------------------------------------------------

  insertMemory(input: mem.NewMemory, ctx: mem.InsertContext): Memory {
    return mem.insertMemory(this, input, ctx);
  }
  addCorroboration(memoryId: string, observationId: string): Memory {
    return mem.addCorroboration(this, memoryId, observationId);
  }
  recomputeConfidence(id: string, halfLifeDays?: number): Memory {
    return mem.recomputeConfidence(this, id, halfLifeDays);
  }
  getMemory(idOrPrefix: string): Memory {
    return mem.getMemory(this, idOrPrefix);
  }
  listMemories(filter?: { status?: MemoryStatus; kind?: MemoryKind }): Memory[] {
    return mem.listMemories(this, filter);
  }
  memorySources(id: string): Observation[] {
    return mem.memorySources(this, id);
  }
  memoryEntities(id: string): Entity[] {
    return mem.memoryEntities(this, id);
  }
  memoryEvents(id: string): MemoryEvent[] {
    return mem.memoryEvents(this, id);
  }
  approve(id: string, edits?: { statement?: string; tier?: Tier }): Memory {
    return mem.approve(this, id, edits);
  }
  reject(id: string, note?: string): Memory {
    return mem.reject(this, id, note ?? null);
  }
  retract(id: string, note?: string): Memory {
    return mem.retract(this, id, note ?? null);
  }
  expire(id: string, note?: string): Memory {
    return mem.expire(this, id, note ?? null);
  }
  findNeighbors(
    query: { statement: string; entityIds: string[] },
    opts?: { limit?: number; minSimilarity?: number },
  ): mem.Neighbor[] {
    return mem.findNeighbors(this, query, opts);
  }
  memoriesAsOf(q: { validAt: Date; recordedAt?: Date }): Memory[] {
    return mem.memoriesAsOf(this, q);
  }

  // ---- exemplars ----------------------------------------------------------

  insertExemplar(input: { observationId: string; text: string; lang: Lang; register: Register }): Exemplar | null {
    return exm.insertExemplar(this, input);
  }
  approveExemplar(id: string): Exemplar {
    return exm.approveExemplar(this, id);
  }
  rejectExemplar(id: string): Exemplar {
    return exm.rejectExemplar(this, id);
  }
  listExemplars(filter?: { status?: ExemplarStatus }): Exemplar[] {
    return exm.listExemplars(this, filter);
  }

  // ---- consolidation ------------------------------------------------------

  consolidate(config: Config): ConsolidationReport {
    return consolidate(this, config);
  }
}

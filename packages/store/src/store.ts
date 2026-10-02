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

export interface StoreOptions {
  path: string;
  clock?: Clock;
}

export function openStore(opts: StoreOptions): Store {
  return new Store(openDatabase(opts.path), opts.clock ?? systemClock);
}

export class Store {
  constructor(
    readonly db: DatabaseSync,
    readonly clock: Clock,
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
      .run(id, o.sourceKind, o.sourceRef, o.authorRole, o.lang, o.text, hash, o.occurredAt, this.nowIso(), JSON.stringify(o.meta));
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
}

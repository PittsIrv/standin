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
import * as spans from "./spans.ts";
import * as tree from "./tree.ts";
import * as probes from "./probes.ts";
import * as hyp from "./hypotheses.ts";
import * as qs from "./questions.ts";
import type { SpanContent, SpanData, SpanSink } from "@standin/trace";
import { consolidate, purge, type ConsolidationReport } from "./consolidate.ts";

export interface QueueDecision {
  itemId: string;
  itemKind: "memory" | "still-true" | "exemplar";
  group: string | null;
  /** 0-based position in the queue when decided; null if the item wasn't in it. */
  position: number | null;
  decision: "approve" | "reject" | "keep" | "expire";
}
import type {
  Config,
  Exemplar,
  ExemplarStatus,
  Memory,
  MemoryEvent,
  MemoryKind,
  MemoryStatus,
  Register,
  Tier,
  Actor,
  EdgeKind,
  Gap,
  Hypothesis,
  HypothesisStatus,
  Question,
  QuestionStatus,
  RootKey,
  Topic,
  TopicEdge,
  AnswerModeName,
  Probe,
  ProbeKind,
  ProbeResponse,
  Rating,
  ReviewSession,
} from "@standin/schema";

export interface CompactionBatch {
  id: string;
  providerBatchId: string;
  model: string;
  submittedAt: string;
  /** In submission order. */
  observationIds: string[];
}

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
        `INSERT INTO observations (id, source_kind, source_ref, author_role, text, content_hash, occurred_at, ingested_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        o.sourceKind,
        o.sourceRef,
        o.authorRole,
        o.text,
        hash,
        new Date(o.occurredAt).toISOString(),
        this.nowIso(),
        JSON.stringify(o.meta),
      );
    return this.getObservation(id);
  }

  /** The observation `addObservation` would dedupe this content against, if any (still found after its text is purged). */
  findObservationByContent(sourceKind: string, text: string): Observation | null {
    const hash = contentHash(sourceKind, normalizeText(text));
    const row = this.db.prepare("SELECT * FROM observations WHERE content_hash = ?").get(hash) as Row | undefined;
    return row ? rowToObservation(row) : null;
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
           AND id NOT IN (
             SELECT i.observation_id FROM compaction_batch_items i
             JOIN compaction_batches b ON b.id = i.batch_id WHERE b.closed_at IS NULL
           )
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

  // ---- compaction batches -------------------------------------------------

  /** The batch awaiting collection, if any. Its observations are excluded from `uncompactedObservations`. */
  openCompactionBatch(): CompactionBatch | null {
    const row = this.db.prepare("SELECT * FROM compaction_batches WHERE closed_at IS NULL").get() as Row | undefined;
    if (!row) return null;
    const items = this.db
      .prepare("SELECT observation_id FROM compaction_batch_items WHERE batch_id = ? ORDER BY position")
      .all(row.id as string) as { observation_id: string }[];
    return {
      id: row.id as string,
      providerBatchId: row.provider_batch_id as string,
      model: row.model as string,
      submittedAt: row.submitted_at as string,
      observationIds: items.map((i) => i.observation_id),
    };
  }

  createCompactionBatch(input: { providerBatchId: string; model: string; observationIds: string[] }): CompactionBatch {
    return this.transaction(() => {
      const open = this.openCompactionBatch();
      if (open) throw new Error(`compaction batch ${open.id} is still open`);
      const id = newId("cb");
      this.db
        .prepare("INSERT INTO compaction_batches (id, provider_batch_id, model, submitted_at) VALUES (?, ?, ?, ?)")
        .run(id, input.providerBatchId, input.model, this.nowIso());
      const insert = this.db.prepare("INSERT INTO compaction_batch_items (batch_id, observation_id, position) VALUES (?, ?, ?)");
      input.observationIds.forEach((o, i) => insert.run(id, o, i));
      return this.openCompactionBatch()!;
    });
  }

  /** `abandoned` returns the batch's unprocessed observations to the pending pool. */
  closeCompactionBatch(id: string, outcome: "collected" | "abandoned"): void {
    const r = this.db
      .prepare("UPDATE compaction_batches SET closed_at = ?, outcome = ? WHERE id = ? AND closed_at IS NULL")
      .run(this.nowIso(), outcome, id);
    if (r.changes === 0) throw new NotFoundError("open compaction batch", id);
  }

  // ---- entities -----------------------------------------------------------

  /** Finds an entity of the same kind by normalized name or alias, without creating one. */
  findEntity(input: { name: string; kind: EntityKind; aliases?: string[] }): Entity | null {
    const keys = new Set([input.name, ...(input.aliases ?? [])].map(normalizeName).filter(Boolean));
    const candidates = (this.db.prepare("SELECT * FROM entities WHERE kind = ?").all(input.kind) as Row[]).map(rowToEntity);
    return candidates.find((e) => [e.name, ...e.aliases].some((n) => keys.has(normalizeName(n)))) ?? null;
  }

  /** Finds an entity of the same kind by normalized name or alias, creating it if absent. */
  resolveEntity(input: { name: string; kind: EntityKind; aliases?: string[] }): Entity {
    const existing = this.findEntity(input);
    if (existing) return existing;
    const id = newId("ent");
    this.db
      .prepare("INSERT INTO entities (id, kind, name, aliases) VALUES (?, ?, ?, ?)")
      .run(id, input.kind, input.name.trim(), JSON.stringify(input.aliases ?? []));
    return { id, kind: input.kind, name: input.name.trim(), aliases: input.aliases ?? [] };
  }

  /** Every entity except the six root nodes. */
  listEntities(): Entity[] {
    return (
      this.db
        .prepare("SELECT e.* FROM entities e LEFT JOIN topics t ON t.entity_id = e.id WHERE t.root_key IS NULL ORDER BY e.kind, e.name")
        .all() as Row[]
    ).map(rowToEntity);
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
  memorySourceSummary(id: string): mem.SourceSummary {
    return mem.memorySourceSummary(this, id);
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
  reject(id: string, note?: string, actor?: Actor): Memory {
    return mem.reject(this, id, note ?? null, actor);
  }
  retract(id: string, note?: string): Memory {
    return mem.retract(this, id, note ?? null);
  }
  expire(id: string, note?: string, actor?: Actor): Memory {
    return mem.expire(this, id, note ?? null, actor);
  }
  staleCurrentState(freshnessDays: number): Memory[] {
    return mem.staleCurrentState(this, freshnessDays);
  }
  keepCurrent(id: string): Memory {
    return mem.keepCurrent(this, id);
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

  insertExemplar(input: { observationId: string; text: string; register: Register }): Exemplar | null {
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

  /** Deletes raw text of observations compacted before `before`, and the trace text tied to them. Hashes and pointers stay. */
  purge(before: string): { observations: number; spanContent: number } {
    return purge(this, before);
  }

  // ---- review decisions ---------------------------------------------------

  recordQueueDecision(d: QueueDecision): void {
    this.db
      .prepare("INSERT INTO queue_decisions (id, item_id, item_kind, queue_group, position, decision, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId("qdc"), d.itemId, d.itemKind, d.group, d.position, d.decision, this.nowIso());
  }

  // ---- knowledge tree -----------------------------------------------------

  ensureTopic(name: string, definition?: string | null): Topic {
    return tree.ensureTopic(this, name, definition ?? null);
  }
  ensureNode(name: string, label: EntityKind, definition?: string | null): Topic {
    return tree.ensureNode(this, name, label, definition ?? null);
  }

  homeParent(id: string): string | null {
    return tree.homeParent(this, id);
  }

  rootOf(id: string): RootKey | null {
    return tree.rootOf(this, id);
  }

  nodeMemories(nodeId: string, filter?: { status?: MemoryStatus }): Memory[] {
    return tree.nodeMemories(this, nodeId, filter);
  }

  /** Moves a memory to a node (or makes it homeless). */
  setHome(memoryId: string, nodeId: string | null): Memory {
    const m = this.getMemory(memoryId);
    this.db.prepare("UPDATE memories SET home_node_id = ? WHERE id = ?").run(nodeId, m.id);
    return this.getMemory(m.id);
  }

  /** How many memories the node held when a split was last considered (0 if never). */
  splitChecked(id: string): number {
    const r = this.db.prepare("SELECT split_checked FROM topics WHERE entity_id = ?").get(id) as Row | undefined;
    return r ? Number(r.split_checked) : 0;
  }

  markSplitChecked(id: string, count: number): void {
    this.db.prepare("UPDATE topics SET split_checked = ? WHERE entity_id = ?").run(count, id);
  }

  describeTopic(id: string, d: { definition: string | null; examples: string[] }): Topic {
    return tree.describeTopic(this, id, d);
  }

  renameTopic(id: string, name: string): Topic {
    return tree.renameTopic(this, id, name);
  }

  moveTopic(id: string, parentId: string | null, source?: TopicEdge["source"]): TopicEdge | null {
    return tree.moveTopic(this, id, parentId, source);
  }

  deleteEdge(id: string): void {
    tree.deleteEdge(this, id);
  }

  deleteTopic(id: string): Topic {
    return tree.deleteTopic(this, id);
  }

  // ---- hypotheses ---------------------------------------------------------

  insertHypothesis(h: hyp.NewHypothesis): Hypothesis {
    return hyp.insertHypothesis(this, h);
  }

  getHypothesis(id: string): Hypothesis {
    return hyp.getHypothesis(this, id);
  }

  listHypotheses(f?: { status?: HypothesisStatus; nodeId?: string }): Hypothesis[] {
    return hyp.listHypotheses(this, f);
  }

  settleHypothesis(id: string): Hypothesis {
    return hyp.setHypothesisStatus(this, id, "settled");
  }

  withdrawHypothesis(id: string): Hypothesis {
    return hyp.setHypothesisStatus(this, id, "withdrawn");
  }

  // ---- small settings -------------------------------------------------------

  getKv(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return r ? String(r.value) : null;
  }

  deleteKv(key: string): void {
    this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  }
  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  roots(): Topic[] {
    return tree.roots(this);
  }

  root(key: RootKey): Topic {
    return tree.root(this, key);
  }

  getTopic(id: string): Topic {
    return tree.getTopic(this, id);
  }
  listTopics(opts?: { includeDeleted?: boolean; includeRoots?: boolean }): Topic[] {
    return tree.listTopics(this, opts);
  }
  findByAnchor(anchor: string): Topic | null {
    return tree.findByAnchor(this, anchor);
  }
  setTopic(id: string, patch: Parameters<typeof tree.setTopic>[2]): Topic {
    return tree.setTopic(this, id, patch);
  }
  addEdge(e: { from: string; to: string; kind: EdgeKind; source: TopicEdge["source"] }): TopicEdge | null {
    return tree.addEdge(this, e);
  }
  listEdges(kind?: EdgeKind): TopicEdge[] {
    return tree.listEdges(this, kind);
  }
  mergeTopics(fromId: string, intoId: string): void {
    tree.mergeTopics(this, fromId, intoId);
  }
  addGap(g: tree.NewGap): Gap | null {
    return tree.addGap(this, g);
  }
  setGap(id: string, patch: { status?: Gap["status"]; level?: number }): Gap {
    return tree.setGap(this, id, patch);
  }

  // ---- probing ------------------------------------------------------------

  startSession(size: number): ReviewSession {
    return probes.startSession(this, size);
  }
  endSession(id: string): ReviewSession {
    return probes.endSession(this, id);
  }
  listSessions(): ReviewSession[] {
    return probes.listSessions(this);
  }
  insertProbe(p: Parameters<typeof probes.insertProbe>[1]): Probe {
    return probes.insertProbe(this, p);
  }
  getProbe(id: string): Probe {
    return probes.getProbe(this, id);
  }
  listProbes(f?: { nodeId?: string; kind?: ProbeKind }): Probe[] {
    return probes.listProbes(this, f);
  }
  showProbe(probeId: string, sessionId: string, predictedMode: AnswerModeName, p?: { predictedP: number; priorP: number }): ProbeResponse {
    return probes.showProbe(this, probeId, sessionId, predictedMode, p);
  }
  addQuestion(q: { nodeId: string; text: string }): Question {
    return qs.addQuestion(this, q);
  }
  getQuestion(id: string): Question {
    return qs.getQuestion(this, id);
  }
  listQuestions(f?: { status?: QuestionStatus; nodeId?: string }): Question[] {
    return qs.listQuestions(this, f);
  }
  setQuestionStatus(id: string, status: QuestionStatus): Question {
    return qs.setQuestionStatus(this, id, status);
  }
  carryResponse(id: string, sessionId: string): ProbeResponse {
    return probes.carryResponse(this, id, sessionId);
  }
  answerCard(id: string, answer: number | "wouldnt_say"): ProbeResponse {
    return probes.answerCard(this, id, answer);
  }

  /** The latest concept-card level per node. */
  stateds(): Map<string, { level: number; responseId: string; answeredAt: string }> {
    return probes.stateds(this);
  }

  getResponse(id: string): ProbeResponse {
    return probes.getResponse(this, id);
  }
  rateResponse(id: string, rating: Rating, spotCheck: boolean): ProbeResponse {
    return probes.rateResponse(this, id, rating, spotCheck);
  }
  answerSpotCheck(id: string, answer: string, observationId: string): ProbeResponse {
    return probes.answerSpotCheck(this, id, answer, observationId);
  }
  judgeResponse(id: string, judged: "gap" | "not_gap"): ProbeResponse {
    return probes.judgeResponse(this, id, judged);
  }
  recordGrade(id: string, grade: "pass" | "fail", reason: string): ProbeResponse {
    return probes.recordGrade(this, id, grade, reason);
  }
  setGradeBatch(ids: string[], batchId: string | null): void {
    probes.setGradeBatch(this, ids, batchId);
  }
  listResponses(f?: { sessionId?: string; rated?: boolean; ungraded?: boolean }): (ProbeResponse & { probe: Probe })[] {
    return probes.listResponses(this, f);
  }
  releaseRotating(sessionIds: string[]): Probe[] {
    return probes.releaseRotating(this, sessionIds);
  }
  listGaps(): Gap[] {
    return tree.listGaps(this);
  }
  topicMemories(topicId: string, filter?: { kind?: MemoryKind; status?: MemoryStatus }): Memory[] {
    return tree.topicMemories(this, topicId, filter);
  }

  // ---- traces -------------------------------------------------------------

  spanSink(): SpanSink {
    return spans.spanSink(this);
  }
  usage(opts: { since?: string; by: "role" | "model" }): spans.UsageRow[] {
    return spans.usage(this, opts);
  }
  listRuns(opts: { since?: string; kind?: string; limit?: number }): spans.RunSummary[] {
    return spans.listRuns(this, opts);
  }
  getTrace(idOrPrefix: string): { span: SpanData; content: SpanContent | null }[] {
    return spans.getTrace(this, idOrPrefix);
  }
  lastTraceId(): string | null {
    return spans.lastTraceId(this);
  }
}

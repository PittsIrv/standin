import type { LLM } from "@standin/llm";
import type { Config, Memory, MemoryAttrs, Observation } from "@standin/schema";
import { computeConfidence, type NewMemory, type Store } from "@standin/store";
import { noopTracer, type Span, type Tracer } from "@standin/trace";
import { buildExtractionPrompt, buildReconcilePrompt } from "./prompts.ts";
import { salience, type Novelty } from "./salience.ts";
import { ExtractionSchema, ReconcileSchema, type ExtractedMemory, type Extraction, type ReconcileAction } from "./schemas.ts";

export interface CompactionReport {
  processed: number;
  skippedExposed: number;
  failed: { observationId: string; error: string }[];
  created: number;
  corroborated: number;
  droppedAsRejected: number;
  updates: number;
  contradictions: number;
  exemplars: number;
  /** Candidates the model returned without the attributes their kind requires. */
  invalidCandidates: number;
}

export interface CompactOptions {
  store: Store;
  /** Extraction model. */
  llm: LLM;
  /** Reconciliation model; defaults to `llm`. */
  reconcileLLM?: LLM;
  config: Config;
  limit?: number;
  retryFailed?: boolean;
  /** Records the run as a trace; defaults to a tracer that records nothing. */
  tracer?: Tracer;
}

interface Planned {
  candidate: ExtractedMemory;
  attrs: MemoryAttrs;
  action: ReconcileAction;
  target: Memory | null;
}

export const emptyReport = (): CompactionReport => ({
  processed: 0,
  skippedExposed: 0,
  failed: [],
  created: 0,
  corroborated: 0,
  droppedAsRejected: 0,
  updates: 0,
  contradictions: 0,
  exemplars: 0,
  invalidCandidates: 0,
});

/**
 * Turns uncompacted observations into proposed memories. Model calls happen first; all writes for one
 * observation then happen in a single transaction, so a crash never leaves half an observation applied.
 */
export async function compact(opts: CompactOptions): Promise<CompactionReport> {
  const { store, llm, config } = opts;
  const tracer = opts.tracer ?? noopTracer;
  return tracer.run("compaction", { "standin.compaction.mode": "live" }, async (run) => {
    const report = emptyReport();
    const pending = takePending(store, config, report, opts);
    for (const o of pending) {
      await finishObservation(store, opts.reconcileLLM ?? llm, config, o, report, tracer, () =>
        llm.generateObject({ ...extractionRequest(o, config), schema: ExtractionSchema }),
      );
    }
    recordReport(run, report);
    return report;
  });
}

export function recordReport(run: Span, report: CompactionReport): void {
  run.setAttributes({
    "standin.compaction.processed": report.processed,
    "standin.compaction.failed": report.failed.length,
    "standin.compaction.created": report.created,
    "standin.compaction.skipped_exposed": report.skippedExposed,
  });
}

export function extractionRequest(o: Observation, config: Config) {
  return { ...buildExtractionPrompt(o, config.persona.name), purpose: "extract" };
}

/** The next uncompacted observations; `exposed` ones are marked skipped on the way, since they never become knowledge. */
export function takePending(
  store: Store,
  config: Config,
  report: CompactionReport,
  opts: { limit?: number; retryFailed?: boolean },
): Observation[] {
  const out: Observation[] = [];
  for (const o of store.uncompactedObservations(opts.limit ?? config.compaction.batchSize, { retryFailed: opts.retryFailed })) {
    if (o.authorRole === "exposed") {
      store.markCompacted(o.id, "skipped_exposed");
      report.skippedExposed++;
    } else out.push(o);
  }
  return out;
}

/** Reconciles one observation's extraction and applies it in one transaction; any failure marks the observation failed. */
export async function finishObservation(
  store: Store,
  reconcileLLM: LLM,
  config: Config,
  o: Observation,
  report: CompactionReport,
  tracer: Tracer,
  extract: () => Promise<Extraction>,
): Promise<void> {
  const attributes = { "standin.observation.id": o.id, "standin.observation.source": o.sourceKind };
  await tracer.span("compaction.observation", { attributes }, async (span) => {
    try {
      const extraction = await extract();
      const plans = await planCandidates(store, reconcileLLM, config, extraction, report);
      await tracer.span("store.apply", { attributes: { "standin.candidates": plans.length } }, async () =>
        store.transaction(() => apply(store, config, o, plans, extraction, report)),
      );
      report.processed++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.markCompacted(o.id, "failed");
      report.failed.push({ observationId: o.id, error: message });
      span.setStatus("error", message);
    }
  });
}

function toAttrs(c: ExtractedMemory): MemoryAttrs | null {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  switch (c.kind) {
    case "competence":
      return c.competence && c.competence.domain.trim()
        ? { domain: c.competence.domain.trim(), depth: clamp(c.competence.depth, 0, 4) }
        : null;
    case "stance":
      return c.stance && c.stance.topic.trim() ? { topic: c.stance.topic.trim(), strength: clamp(c.stance.strength, 1, 5) } : null;
    default:
      return {};
  }
}

async function planCandidates(
  store: Store,
  llm: LLM,
  config: Config,
  extraction: Extraction,
  report: CompactionReport,
): Promise<Planned[]> {
  const plans: Planned[] = [];
  for (const candidate of extraction.memories) {
    const attrs = toAttrs(candidate);
    if (!attrs || !candidate.statement.trim()) {
      report.invalidCandidates++;
      continue;
    }
    // Read-only lookups here; entities are created later inside the write transaction.
    const entityIds = candidate.entities
      .map((e) => store.findEntity(e)?.id)
      .filter((id): id is string => id !== undefined);
    const neighbors = store.findNeighbors({ statement: candidate.statement, entityIds }).map((n) => n.memory);
    if (neighbors.length === 0) {
      plans.push({ candidate, attrs, action: "new", target: null });
      continue;
    }
    const decision = await llm.generateObject({
      ...buildReconcilePrompt(candidate, neighbors, config.persona.name),
      schema: ReconcileSchema,
      purpose: "reconcile",
    });
    const target = neighbors.find((m) => m.id === decision.targetId) ?? null;
    plans.push(
      decision.action === "new" || target === null
        ? { candidate, attrs, action: "new", target: null }
        : { candidate, attrs, action: decision.action, target },
    );
  }
  return plans;
}

const isoOrNull = (s: string | null): string | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function apply(store: Store, config: Config, o: Observation, plans: Planned[], extraction: Extraction, report: CompactionReport) {
  for (const p of plans) {
    const { candidate: c, target } = p;
    let action = p.action;
    if (target?.status === "rejected") {
      if (action === "duplicate") {
        report.droppedAsRejected++;
        continue;
      }
      action = "new";
    }
    if (action === "duplicate" && target) {
      store.addCorroboration(target.id, o.id);
      report.corroborated++;
      continue;
    }

    const entityIds = c.entities.map((e) => store.resolveEntity(e).id);
    const confidence = computeConfidence({
      affirmed: false,
      sources: [{ sourceKind: o.sourceKind, authorRole: o.authorRole }],
      isCurrentState: c.isCurrentState,
      lastCorroboratedAt: store.nowIso(),
      now: store.clock.now(),
      halfLifeDays: config.consolidation.currentStateHalfLifeDays,
    });
    const novelty: Novelty = action === "update" ? "update" : action === "contradiction" ? "contradiction" : "new";
    const linksTarget = (action === "update" || action === "contradiction") && target !== null;
    const input = {
      kind: c.kind,
      statement: c.statement,
      lang: c.lang,
      tier: c.suggestedTier,
      isCurrentState: c.isCurrentState,
      attrs: p.attrs,
      // A replacement takes effect when it was observed, unless the text says otherwise.
      validFrom: isoOrNull(c.validFrom) ?? (linksTarget ? o.occurredAt : null),
      validUntil: isoOrNull(c.validUntil),
      supersedesId: action === "update" && target ? target.id : null,
      conflictsWithId: action === "contradiction" && target ? target.id : null,
    } as NewMemory;
    store.insertMemory(input, {
      sourceObservationIds: [o.id],
      entityIds,
      actor: "compaction",
      salience: salience({ kind: c.kind, confidence, novelty }),
    });
    if (action === "update") report.updates++;
    else if (action === "contradiction") report.contradictions++;
    else report.created++;
  }

  if (o.authorRole === "self") {
    for (const e of extraction.exemplars) {
      if (!e.text.trim()) continue;
      if (store.insertExemplar({ observationId: o.id, text: e.text, lang: o.lang, register: e.register })) report.exemplars++;
    }
  }
  store.markCompacted(o.id, "processed");
}

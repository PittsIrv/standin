import { LLMError, type BatchLLM, type BatchStatus, type LLM } from "@standin/llm";
import type { Config } from "@standin/schema";
import type { Store } from "@standin/store";
import { emptyReport, extractionRequest, finishObservation, takePending, type CompactionReport } from "./compact.ts";
import { ExtractionSchema } from "./schemas.ts";

export interface CompactBatchOptions {
  store: Store;
  /** Extraction model; must support batches. */
  llm: BatchLLM;
  /** Reconciliation model, called live during collection; defaults to `llm`. */
  reconcileLLM?: LLM;
  config: Config;
  /** Recorded with the batch, for display. */
  modelLabel: string;
  limit?: number;
  retryFailed?: boolean;
}

export type BatchStep =
  | { kind: "idle"; skippedExposed: number }
  | { kind: "submitted"; batchId: string; observations: number; skippedExposed: number }
  | { kind: "processing"; batchId: string; status: BatchStatus }
  | { kind: "collected"; batchId: string; report: CompactionReport };

/**
 * One step of batch compaction. Only extraction (the long, expensive call) is
 * batched. Reconciliation stays live and in order at collection time, so each
 * observation is still compared against everything applied before it.
 *
 * With no open batch, submits the pending observations. With an open batch,
 * collects it if the provider has finished. Collecting is resumable: a crash
 * mid-way leaves the batch open, and the next run skips what was applied.
 */
export async function compactBatch(opts: CompactBatchOptions): Promise<BatchStep> {
  const { store, llm, config } = opts;
  const open = store.openCompactionBatch();

  if (!open) {
    const report = emptyReport();
    const pending = takePending(store, config, report, opts);
    if (pending.length === 0) return { kind: "idle", skippedExposed: report.skippedExposed };
    const providerBatchId = await llm.submitBatch(
      pending.map((o) => ({ id: o.id, req: { ...extractionRequest(o, config), schema: ExtractionSchema } })),
    );
    store.createCompactionBatch({ providerBatchId, model: opts.modelLabel, observationIds: pending.map((o) => o.id) });
    return { kind: "submitted", batchId: providerBatchId, observations: pending.length, skippedExposed: report.skippedExposed };
  }

  const status = await llm.batchStatus(open.providerBatchId);
  if (!status.ended) return { kind: "processing", batchId: open.providerBatchId, status };

  const results = await llm.batchResults(open.providerBatchId, ExtractionSchema);
  const report = emptyReport();
  for (const id of open.observationIds) {
    const o = store.getObservation(id);
    if (o.compactedAt) continue; // applied by an earlier, interrupted collection
    const outcome = results.get(id) ?? { ok: false as const, error: "missing from batch results", kind: "api_error" as const, usage: null };
    await finishObservation(store, opts.reconcileLLM ?? llm, config, o, report, async () => {
      if (!outcome.ok) throw new LLMError(outcome.kind, outcome.error);
      return outcome.value;
    });
  }
  store.closeCompactionBatch(open.id, "collected");
  return { kind: "collected", batchId: open.providerBatchId, report };
}

/** Gives up on the open batch; its observations go back to the pending pool. Returns the provider batch id. */
export function abandonBatch(store: Store): string | null {
  const open = store.openCompactionBatch();
  if (!open) return null;
  store.closeCompactionBatch(open.id, "abandoned");
  return open.providerBatchId;
}

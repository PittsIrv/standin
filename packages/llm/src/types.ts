import type { z } from "zod";

export interface GenerateObjectRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** A routing label for fakes and logs, e.g. "extract" or "reconcile". */
  purpose?: string;
}

/** The only capability compaction needs from a model: return an object matching a schema. */
export interface LLM {
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T>;
}

export class LLMError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LLMError";
  }
}

export interface BatchRequest<T> {
  /** Caller-chosen id, unique within the batch; results are keyed by it. */
  id: string;
  req: GenerateObjectRequest<T>;
}

export type BatchOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BatchStatus {
  ended: boolean;
  processing: number;
  succeeded: number;
  errored: number;
}

/**
 * Asynchronous bulk calls (for Anthropic, the Message Batches API at about half the price).
 * Results usually arrive within an hour and at most 24 hours later.
 */
export interface BatchLLM extends LLM {
  submitBatch(requests: BatchRequest<unknown>[]): Promise<string>;
  batchStatus(batchId: string): Promise<BatchStatus>;
  /** Every result validated against `schema`. Requests missing from the results are absent from the map. */
  batchResults<T>(batchId: string, schema: z.ZodType<T>): Promise<Map<string, BatchOutcome<T>>>;
}

export function supportsBatch(llm: LLM): llm is BatchLLM {
  return typeof (llm as Partial<BatchLLM>).submitBatch === "function";
}

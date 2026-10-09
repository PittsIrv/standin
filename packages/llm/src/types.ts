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

export type LLMErrorKind = "invalid" | "refusal" | "truncated" | "api_error" | "unreachable";

export class LLMError extends Error {
  constructor(
    readonly kind: LLMErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LLMError";
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const ZERO_USAGE: Usage = Object.freeze({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface Generation<T> {
  output: T;
  usage: Usage;
  /** The model that actually answered; may differ from the requested one (server-side fallback). */
  responseModel: string;
}

/** A concrete model endpoint. Callers that don't need usage keep using `LLM.generateObject`. */
export interface ModelProvider extends LLM {
  readonly provider: "anthropic" | "openai-compatible" | "scripted";
  readonly model: string;
  generate<T>(req: GenerateObjectRequest<T>): Promise<Generation<T>>;
}

export interface BatchRequest<T> {
  /** Caller-chosen id, unique within the batch; results are keyed by it. */
  id: string;
  req: GenerateObjectRequest<T>;
}

export type BatchOutcome<T> =
  | { ok: true; value: T; usage: Usage; responseModel: string }
  | { ok: false; error: string; kind: LLMErrorKind; usage: Usage | null };

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
  batchResults<T>(batchId: string, schema: z.ZodType<T>, meta?: { submittedAt?: string }): Promise<Map<string, BatchOutcome<T>>>;
}

export function supportsBatch(llm: LLM): llm is BatchLLM {
  return typeof (llm as Partial<BatchLLM>).submitBatch === "function";
}

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

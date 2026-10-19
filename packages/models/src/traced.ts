import {
  LLMError,
  supportsBatch,
  type BatchLLM,
  type BatchOutcome,
  type BatchRequest,
  type BatchStatus,
  type GenerateObjectRequest,
  type ModelProvider,
  type Usage,
} from "@standin/llm";
import type { ModelTier, Price, Role } from "@standin/schema";
import type { MaybeAttrs, Tracer } from "@standin/trace";
import type { z } from "zod";
import { costUsd, priceFor } from "./pricing.ts";

export interface TracedModelOptions {
  role: Role;
  /** "override" when config sets this role's model directly. */
  tier: ModelTier | "override";
  tracer: Tracer;
  prices: Record<string, Price>;
}

/**
 * A model bound to a role. Every call becomes an OpenTelemetry GenAI client span
 * (`chat {model}`) carrying usage, cost and outcome; prompts and outputs go to the
 * span's content, which is stored apart from its attributes.
 */
export class TracedModel implements BatchLLM {
  constructor(
    private readonly provider: ModelProvider,
    private readonly opts: TracedModelOptions,
  ) {}

  get model(): string {
    return this.provider.model;
  }

  /** Whether the underlying provider has a batch API. */
  get batchCapable(): boolean {
    return supportsBatch(this.provider);
  }

  private baseAttrs(req: GenerateObjectRequest<unknown> | null, batch: boolean): MaybeAttrs {
    return {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": this.provider.provider,
      "gen_ai.request.model": this.provider.model,
      "gen_ai.request.max_tokens": req?.maxTokens,
      "gen_ai.output.type": "json",
      "standin.role": this.opts.role,
      "standin.tier": this.opts.tier,
      "standin.purpose": req?.purpose,
      "standin.batch": batch,
    };
  }

  private usageAttrs(usage: Usage, responseModel: string, batch: boolean): MaybeAttrs {
    return {
      "gen_ai.response.model": responseModel,
      // GenAI conventions: input_tokens includes tokens read from and written to the cache.
      "gen_ai.usage.input_tokens": usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
      "gen_ai.usage.cache_write.input_tokens": usage.cacheWriteTokens,
      "standin.cost_usd": costUsd(usage, priceFor(responseModel, this.opts.prices), { batch }),
    };
  }

  generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    const r = req as GenerateObjectRequest<unknown>;
    return this.opts.tracer.span(`chat ${this.provider.model}`, { kind: "client", attributes: this.baseAttrs(r, false) }, async (span) => {
      try {
        const g = await this.provider.generate(req);
        span.setAttributes({ ...this.usageAttrs(g.usage, g.responseModel, false), "standin.outcome": "ok" });
        span.setContent({ system: req.system, prompt: req.prompt, output: g.output });
        return g.output;
      } catch (err) {
        const kind = err instanceof LLMError ? err.kind : "api_error";
        span.setAttributes({ "standin.outcome": kind, "error.type": kind });
        span.setContent({ system: req.system, prompt: req.prompt, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    });
  }

  private batchProvider(): BatchLLM {
    if (!supportsBatch(this.provider)) {
      throw new LLMError("api_error", `${this.provider.provider} model ${this.provider.model} has no batch API`);
    }
    return this.provider;
  }

  async submitBatch(requests: BatchRequest<unknown>[]): Promise<string> {
    return this.batchProvider().submitBatch(requests);
  }

  async batchStatus(batchId: string): Promise<BatchStatus> {
    return this.batchProvider().batchStatus(batchId);
  }

  /** Records one span per result (started at submission time) under the active span, then returns the results. */
  async batchResults<T>(batchId: string, schema: z.ZodType<T>, meta: { submittedAt?: string } = {}): Promise<Map<string, BatchOutcome<T>>> {
    const results = await this.batchProvider().batchResults(batchId, schema);
    const startTime = meta.submittedAt ? new Date(meta.submittedAt) : undefined;
    for (const [id, outcome] of results) {
      await this.opts.tracer.span(
        `chat ${this.provider.model}`,
        { kind: "client", startTime, attributes: { ...this.baseAttrs(null, true), "standin.batch_id": batchId, "standin.batch.custom_id": id } },
        async (span) => {
          if (outcome.usage) span.setAttributes(this.usageAttrs(outcome.usage, outcome.ok ? outcome.responseModel : this.provider.model, true));
          if (outcome.ok) {
            span.setAttributes({ "standin.outcome": "ok" });
            span.setContent({ output: outcome.value });
          } else {
            span.setAttributes({ "standin.outcome": outcome.kind, "error.type": outcome.kind });
            span.setContent({ error: outcome.error });
            span.setStatus("error", outcome.error);
          }
        },
      );
    }
    return results;
  }
}

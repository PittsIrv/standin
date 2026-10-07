import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { z } from "zod";
import { parseJsonOutput } from "./json.ts";
import {
  LLMError,
  type BatchLLM,
  type BatchOutcome,
  type BatchRequest,
  type BatchStatus,
  type GenerateObjectRequest,
  type Generation,
  type ModelProvider,
  type Usage,
} from "./types.ts";

/**
 * Models that accept the server-side refusal fallback chain (`fallbacks: "default"`) and `effort`.
 * Others (e.g. Haiku 4.5) get neither unless `effort` is set explicitly.
 */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicLLMOptions {
  model: string;
  client?: Anthropic;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Structured-output calls through the official SDK. Credentials resolve the SDK's default way. */
export class AnthropicLLM implements BatchLLM, ModelProvider {
  readonly provider = "anthropic" as const;
  readonly model: string;
  private readonly client: Anthropic;
  private readonly useFallbacks: boolean;
  private readonly effort: AnthropicLLMOptions["effort"];

  constructor(private readonly opts: AnthropicLLMOptions) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic();
    this.useFallbacks = FALLBACK_MODELS.has(opts.model);
    this.effort = opts.effort ?? (this.useFallbacks ? "medium" : undefined);
  }

  private params<T>(req: GenerateObjectRequest<T>) {
    return {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? 16000,
      // Cacheable prefix; the API simply skips caching below its minimum prompt length.
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: req.prompt }],
      ...(this.useFallbacks ? { fallbacks: "default" as const } : {}),
    };
  }

  private get effortParam() {
    return this.effort ? { effort: this.effort } : {};
  }

  private get betas() {
    return this.useFallbacks ? { betas: [FALLBACK_BETA] } : {};
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    return (await this.generate(req)).output;
  }

  async generate<T>(req: GenerateObjectRequest<T>): Promise<Generation<T>> {
    let response;
    try {
      response = await this.client.beta.messages.parse({
        ...this.params(req),
        ...this.betas,
        output_config: { format: betaZodOutputFormat(req.schema), ...this.effortParam },
      });
    } catch (err) {
      throw wrapApiError(err);
    }
    checkStop(response);
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new LLMError("invalid", "model output did not parse against the schema");
    }
    return { output: response.parsed_output as T, usage: toUsage(response.usage), responseModel: response.model ?? this.model };
  }

  async submitBatch(requests: BatchRequest<unknown>[]): Promise<string> {
    try {
      const batch = await this.client.beta.messages.batches.create({
        ...this.betas,
        requests: requests.map(({ id, req }) => ({
          custom_id: id,
          params: {
            ...this.params(req),
            // Plain JSON schema: the auto-parsing wrapper doesn't survive serialization into a batch.
            output_config: {
              format: { type: "json_schema" as const, schema: betaZodOutputFormat(req.schema).schema },
              ...this.effortParam,
            },
          },
        })),
      });
      return batch.id;
    } catch (err) {
      throw wrapApiError(err);
    }
  }

  async batchStatus(batchId: string): Promise<BatchStatus> {
    try {
      const b = await this.client.beta.messages.batches.retrieve(batchId);
      const c = b.request_counts;
      return {
        ended: b.processing_status === "ended",
        processing: c.processing,
        succeeded: c.succeeded,
        errored: c.errored + c.canceled + c.expired,
      };
    } catch (err) {
      throw wrapApiError(err);
    }
  }

  async batchResults<T>(batchId: string, schema: z.ZodType<T>): Promise<Map<string, BatchOutcome<T>>> {
    const out = new Map<string, BatchOutcome<T>>();
    try {
      for await (const r of await this.client.beta.messages.batches.results(batchId)) {
        if (r.result.type !== "succeeded") {
          const detail = r.result.type === "errored" ? `: ${r.result.error.error.message}` : "";
          out.set(r.custom_id, { ok: false, error: `batch request ${r.result.type}${detail}`, kind: "api_error", usage: null });
          continue;
        }
        const message = r.result.message;
        const usage = toUsage(message.usage);
        try {
          checkStop(message);
          const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
          out.set(r.custom_id, { ok: true, value: parseJsonOutput(text, schema), usage, responseModel: message.model ?? this.model });
        } catch (err) {
          const kind = err instanceof LLMError ? err.kind : "invalid";
          out.set(r.custom_id, { ok: false, error: err instanceof Error ? err.message : String(err), kind, usage });
        }
      }
    } catch (err) {
      throw wrapApiError(err);
    }
    return out;
  }
}

function checkStop(message: Pick<BetaMessage, "stop_reason" | "stop_details">): void {
  if (message.stop_reason === "refusal") {
    throw new LLMError("refusal", `model refused (${message.stop_details?.category ?? "unknown category"})`);
  }
  if (message.stop_reason === "max_tokens") throw new LLMError("truncated", "output truncated at max_tokens");
}

function wrapApiError(err: unknown): unknown {
  if (err instanceof Anthropic.APIConnectionError) return new LLMError("unreachable", `could not reach the Anthropic API: ${err.message}`, { cause: err });
  if (err instanceof Anthropic.APIError) return new LLMError("api_error", `Anthropic API error ${err.status}: ${err.message}`, { cause: err });
  return err;
}

type ApiUsage = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

function toUsage(u: ApiUsage | null | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

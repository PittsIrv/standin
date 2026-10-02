import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LLMError, type GenerateObjectRequest, type LLM } from "./types.ts";

/** Models that accept the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export interface AnthropicLLMOptions {
  model: string;
  client?: Anthropic;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/** Structured-output calls through the official SDK. Credentials resolve the SDK's default way. */
export class AnthropicLLM implements LLM {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicLLMOptions) {
    this.client = opts.client ?? new Anthropic();
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    const useFallbacks = FALLBACK_MODELS.has(this.opts.model);
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.opts.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.prompt }],
        output_config: { format: betaZodOutputFormat(req.schema), effort: this.opts.effort ?? "medium" },
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) throw new LLMError(`Anthropic API error ${err.status}: ${err.message}`, { cause: err });
      throw err;
    }
    if (response.stop_reason === "refusal") {
      throw new LLMError(`model refused (${response.stop_details?.category ?? "unknown category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new LLMError("output truncated at max_tokens");
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new LLMError("model output did not parse against the schema");
    }
    return response.parsed_output as T;
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { AnthropicLLM } from "./anthropic.ts";
import { OpenAICompatibleLLM } from "./openai-compatible.ts";
import { LLMError, type ModelProvider } from "./types.ts";

/** Which model to call, as stored in an instance's config. Keys are named by env var, never stored. */
export interface ModelSpec {
  provider: "anthropic" | "openai-compatible";
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  structuredOutput?: "json_schema" | "json_object";
}

export function createLLM(spec: ModelSpec, env: Record<string, string | undefined> = process.env): ModelProvider {
  const apiKey = spec.apiKeyEnv ? env[spec.apiKeyEnv] : undefined;
  if (spec.apiKeyEnv && !apiKey) throw new LLMError("api_error", `${spec.apiKeyEnv} is not set (named by apiKeyEnv for model ${spec.model})`);
  if (spec.provider === "anthropic") {
    return new AnthropicLLM({ model: spec.model, ...(apiKey ? { client: new Anthropic({ apiKey }) } : {}) });
  }
  if (!spec.baseURL) throw new LLMError("api_error", `model ${spec.model}: the openai-compatible provider needs a baseURL`);
  return new OpenAICompatibleLLM({ baseURL: spec.baseURL, model: spec.model, apiKey, structuredOutput: spec.structuredOutput });
}

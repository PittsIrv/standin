import { z } from "zod";
import { parseJsonOutput } from "./json.ts";
import { addUsage, LLMError, ZERO_USAGE, type GenerateObjectRequest, type Generation, type ModelProvider, type Usage } from "./types.ts";

export interface OpenAICompatibleLLMOptions {
  /** e.g. http://localhost:11434/v1 (Ollama), http://localhost:8000/v1 (vLLM), or a hosted endpoint. */
  baseURL: string;
  model: string;
  apiKey?: string;
  /**
   * `json_schema` asks the server to constrain output to the schema (Ollama, vLLM, OpenAI).
   * `json_object` only asks for JSON and puts the schema in the prompt, for servers without schema support.
   */
  structuredOutput?: "json_schema" | "json_object";
  /** Local models can be slow. Default 10 minutes. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

/**
 * Any server that speaks the OpenAI chat-completions protocol: Ollama, vLLM,
 * LM Studio, llama.cpp, and most hosted open-model providers. Output is always
 * re-validated locally, and one invalid reply gets a single repair attempt.
 */
export class OpenAICompatibleLLM implements ModelProvider {
  readonly provider = "openai-compatible" as const;
  readonly model: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: OpenAICompatibleLLMOptions) {
    this.model = opts.model;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<T> {
    return (await this.generate(req)).output;
  }

  async generate<T>(req: GenerateObjectRequest<T>): Promise<Generation<T>> {
    const jsonSchema = z.toJSONSchema(req.schema, { target: "draft-7", io: "output" });
    const mode = this.opts.structuredOutput ?? "json_schema";
    const system =
      mode === "json_object"
        ? `${req.system}\n\nRespond with only a JSON object that matches this JSON Schema:\n${JSON.stringify(jsonSchema)}`
        : req.system;
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: req.prompt },
    ];
    const responseFormat =
      mode === "json_schema"
        ? { type: "json_schema", json_schema: { name: req.purpose ?? "output", schema: jsonSchema } }
        : { type: "json_object" };

    const first = await this.complete(messages, responseFormat, req.maxTokens);
    try {
      return { output: parseJsonOutput(first.content, req.schema), usage: first.usage, responseModel: first.model };
    } catch (err) {
      const problem = err instanceof Error ? err.message : String(err);
      const retry = await this.complete(
        [
          ...messages,
          { role: "assistant", content: first.content },
          { role: "user", content: `That reply was invalid (${problem}). Reply again with only the corrected JSON object.` },
        ],
        responseFormat,
        req.maxTokens,
      );
      // Usage covers both attempts: the failed one was paid for too.
      return { output: parseJsonOutput(retry.content, req.schema), usage: addUsage(first.usage, retry.usage), responseModel: retry.model };
    }
  }

  private async complete(
    messages: ChatMessage[],
    responseFormat: object,
    maxTokens = 16000,
  ): Promise<{ content: string; usage: Usage; model: string }> {
    const url = `${this.opts.baseURL.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.opts.model, messages, max_tokens: maxTokens, response_format: responseFormat }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 600_000),
      });
    } catch (err) {
      throw new LLMError("unreachable", `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 500);
      throw new LLMError("api_error", `${url} returned ${res.status}: ${body}`);
    }
    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") throw new LLMError("truncated", "output truncated at max_tokens");
    const content = choice?.message?.content;
    if (!content) throw new LLMError("invalid", "empty response from model");
    return {
      content,
      usage: { ...ZERO_USAGE, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 },
      model: data.model ?? this.model,
    };
  }
}

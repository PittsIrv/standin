import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLLM, createLLM, LLMError, OpenAICompatibleLLM, parseJsonOutput, supportsBatch } from "../src/index.ts";

const Schema = z.object({ city: z.string(), year: z.number().nullable() });

describe("parseJsonOutput", () => {
  it("accepts plain JSON, fences, think blocks and surrounding prose", () => {
    const want = { city: "Pittsburgh", year: 2022 };
    expect(parseJsonOutput('{"city":"Pittsburgh","year":2022}', Schema)).toEqual(want);
    expect(parseJsonOutput('```json\n{"city":"Pittsburgh","year":2022}\n```', Schema)).toEqual(want);
    expect(parseJsonOutput('<think>hmm {"no":1}</think>\n{"city":"Pittsburgh","year":2022}', Schema)).toEqual(want);
    expect(parseJsonOutput('Sure! Here it is: {"city":"Pittsburgh","year":2022} Hope that helps.', Schema)).toEqual(want);
  });

  it("names the problem when output is not JSON or misses the schema", () => {
    expect(() => parseJsonOutput("no idea", Schema)).toThrow(/not JSON/);
    expect(() => parseJsonOutput('{"city":3}', Schema)).toThrow(/city/);
  });
});

/** A fake chat-completions server that replays canned replies and records requests. */
function fakeServer(replies: (string | { status: number; body: string } | { finish: string })[]) {
  const requests: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const r = replies.shift();
    if (r === undefined) throw new Error("no more replies");
    if (typeof r === "object" && "status" in r) return new Response(r.body, { status: r.status });
    const choice = typeof r === "string" ? { message: { content: r }, finish_reason: "stop" } : { message: { content: "{" }, finish_reason: r.finish };
    return new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

describe("OpenAICompatibleLLM", () => {
  const req = { system: "Extract the city.", prompt: "I moved to Pittsburgh in 2022.", schema: Schema, purpose: "extract" };

  it("sends a JSON-schema response format and parses the reply", async () => {
    const { fetch, requests } = fakeServer(['{"city":"Pittsburgh","year":2022}']);
    const llm = new OpenAICompatibleLLM({ baseURL: "http://localhost:11434/v1/", model: "qwen", apiKey: "k", fetch });
    await expect(llm.generateObject(req)).resolves.toEqual({ city: "Pittsburgh", year: 2022 });
    const [sent] = requests;
    expect(sent!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(sent!.headers.authorization).toBe("Bearer k");
    expect(sent!.body).toMatchObject({ model: "qwen", response_format: { type: "json_schema", json_schema: { name: "extract" } } });
    expect(sent!.body.response_format.json_schema.schema.required).toEqual(["city", "year"]);
    expect(sent!.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
  });

  it("json_object mode puts the schema in the system prompt and sends no key when none is set", async () => {
    const { fetch, requests } = fakeServer(['{"city":"Pittsburgh","year":null}']);
    const llm = new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", structuredOutput: "json_object", fetch });
    await llm.generateObject(req);
    expect(requests[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(requests[0]!.body.messages[0].content).toContain('"city"');
    expect(requests[0]!.headers.authorization).toBeUndefined();
  });

  it("gives one invalid reply a single repair attempt", async () => {
    const { fetch, requests } = fakeServer(['{"city":1}', '{"city":"Pittsburgh","year":2022}']);
    const llm = new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch });
    await expect(llm.generateObject(req)).resolves.toMatchObject({ city: "Pittsburgh" });
    expect(requests[1]!.body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(requests[1]!.body.messages[3].content).toContain("invalid");

    const twice = fakeServer(["nope", "still nope"]);
    await expect(new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch: twice.fetch }).generateObject(req)).rejects.toBeInstanceOf(LLMError);
  });

  it("reports HTTP errors, truncation and unreachable servers as LLMError", async () => {
    const http = fakeServer([{ status: 404, body: "model not found" }]);
    await expect(new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch: http.fetch }).generateObject(req)).rejects.toThrow(/404: model not found/);
    const cut = fakeServer([{ finish: "length" }]);
    await expect(new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch: cut.fetch }).generateObject(req)).rejects.toThrow(/truncated/);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch: down }).generateObject(req)).rejects.toThrow(/could not reach/);
  });
});

describe("createLLM", () => {
  it("builds the configured provider and reads keys only from the named env var", () => {
    const local = createLLM({ provider: "openai-compatible", model: "qwen", baseURL: "http://localhost:11434/v1" }, {});
    expect(local).toBeInstanceOf(OpenAICompatibleLLM);
    expect(supportsBatch(local)).toBe(false);
    const claude = createLLM({ provider: "anthropic", model: "claude-haiku-4-5", apiKeyEnv: "MY_KEY" }, { MY_KEY: "sk-test" });
    expect(claude).toBeInstanceOf(AnthropicLLM);
    expect(supportsBatch(claude)).toBe(true);
    expect(() => createLLM({ provider: "anthropic", model: "m", apiKeyEnv: "MISSING" }, {})).toThrow(/MISSING is not set/);
    expect(() => createLLM({ provider: "openai-compatible", model: "m" }, {})).toThrow(/baseURL/);
  });
});

describe("AnthropicLLM batches (fake client)", () => {
  function fakeClient(results: unknown[]) {
    const created: any[] = [];
    const client = {
      beta: {
        messages: {
          batches: {
            create: async (params: unknown) => {
              created.push(params);
              return { id: "msgbatch_1" };
            },
            retrieve: async () => ({
              processing_status: "ended",
              request_counts: { processing: 0, succeeded: 2, errored: 1, canceled: 0, expired: 1 },
            }),
            results: async () =>
              (async function* () {
                yield* results;
              })(),
          },
        },
      },
    };
    return { client: client as unknown as Anthropic, created };
  }
  const message = (text: string, stop_reason = "end_turn") => ({ type: "succeeded", message: { content: [{ type: "text", text }], stop_reason, stop_details: null } });

  it("submits plain JSON-schema requests with the fallback beta, and validates each result", async () => {
    const { client, created } = fakeClient([
      { custom_id: "a", result: message('{"city":"Pittsburgh","year":2022}') },
      { custom_id: "b", result: message("", "refusal") },
      { custom_id: "c", result: { type: "errored", error: { type: "error", error: { type: "overloaded_error", message: "busy" } } } },
      { custom_id: "d", result: { type: "expired" } },
    ]);
    const llm = new AnthropicLLM({ model: "claude-opus-5-5", client });
    const id = await llm.submitBatch([{ id: "a", req: { system: "s", prompt: "p", schema: Schema } }]);
    expect(id).toBe("msgbatch_1");
    const params = created[0];
    expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
    const format = params.requests[0].params.output_config.format;
    expect(format.type).toBe("json_schema");
    expect(params.requests[0].params.output_config.effort).toBe("medium");
    expect(format.parse).toBeUndefined();
    expect(JSON.parse(JSON.stringify(format))).toEqual(format);

    expect(await llm.batchStatus(id)).toEqual({ ended: true, processing: 0, succeeded: 2, errored: 2 });
    const out = await llm.batchResults(id, Schema);
    expect(out.get("a")).toMatchObject({ ok: true, value: { city: "Pittsburgh", year: 2022 } });
    expect(out.get("b")).toMatchObject({ ok: false, error: expect.stringContaining("refused") });
    expect(out.get("c")).toMatchObject({ ok: false, error: expect.stringContaining("busy") });
    expect(out.get("d")).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
  });

  it("omits the fallback beta for models without it", async () => {
    const { client, created } = fakeClient([]);
    await new AnthropicLLM({ model: "claude-haiku-4-5", client }).submitBatch([{ id: "a", req: { system: "s", prompt: "p", schema: Schema } }]);
    expect(created[0].betas).toBeUndefined();
    expect(created[0].requests[0].params.fallbacks).toBeUndefined();
    expect(created[0].requests[0].params.output_config.effort).toBeUndefined();
  });
});

describe("usage reporting and error kinds", () => {
  const req = { system: "Extract the city.", prompt: "I moved to Pittsburgh in 2022.", schema: Schema };

  function parseClient(response: object | Error) {
    const calls: any[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (params: unknown) => {
            calls.push(params);
            if (response instanceof Error) throw response;
            return response;
          },
        },
      },
    };
    return { client: client as unknown as Anthropic, calls };
  }
  const okResponse = {
    stop_reason: "end_turn",
    stop_details: null,
    parsed_output: { city: "Pittsburgh", year: 2022 },
    model: "claude-opus-5",
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 1000, cache_creation_input_tokens: null },
  };

  it("Anthropic generate returns usage and the response model, and marks the system prompt cacheable", async () => {
    const { client, calls } = parseClient(okResponse);
    const g = await new AnthropicLLM({ model: "claude-opus-5-5", client }).generate(req);
    expect(g).toEqual({
      output: { city: "Pittsburgh", year: 2022 },
      usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 1000, cacheWriteTokens: 0 },
      responseModel: "claude-opus-5",
    });
    expect(calls[0].system).toEqual([{ type: "text", text: "Extract the city.", cache_control: { type: "ephemeral" } }]);
  });

  it("Anthropic classifies failures by kind", async () => {
    const kindOf = async (response: object | Error) => {
      const { client } = parseClient(response);
      try {
        await new AnthropicLLM({ model: "claude-haiku-4-5", client }).generate(req);
      } catch (err) {
        return (err as LLMError).kind;
      }
      return "no error";
    };
    expect(await kindOf({ ...okResponse, stop_reason: "refusal", stop_details: { category: "cyber" } })).toBe("refusal");
    expect(await kindOf({ ...okResponse, stop_reason: "max_tokens" })).toBe("truncated");
    expect(await kindOf({ ...okResponse, parsed_output: null })).toBe("invalid");
    expect(await kindOf(new Anthropic.APIError(529, { type: "error" }, "overloaded", new Headers()))).toBe("api_error");
  });

  it("Anthropic batch requests use a cacheable system block and results carry usage", async () => {
    const created: any[] = [];
    const client = {
      beta: {
        messages: {
          batches: {
            create: async (p: unknown) => (created.push(p), { id: "b1" }),
            results: async () =>
              (async function* () {
                yield {
                  custom_id: "a",
                  result: {
                    type: "succeeded",
                    message: {
                      content: [{ type: "text", text: '{"city":"Pittsburgh","year":null}' }],
                      stop_reason: "end_turn",
                      stop_details: null,
                      model: "claude-opus-5-5",
                      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 7 },
                    },
                  },
                };
                yield { custom_id: "b", result: { type: "expired" } };
              })(),
          },
        },
      },
    } as unknown as Anthropic;
    const llm = new AnthropicLLM({ model: "claude-opus-5-5", client });
    await llm.submitBatch([{ id: "a", req }]);
    expect(created[0].requests[0].params.system).toEqual([{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]);
    const out = await llm.batchResults("b1", Schema);
    expect(out.get("a")).toEqual({
      ok: true,
      value: { city: "Pittsburgh", year: null },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 7 },
      responseModel: "claude-opus-5-5",
    });
    expect(out.get("b")).toMatchObject({ ok: false, kind: "api_error", usage: null });
  });

  it("OpenAI-compatible maps usage, sums it across a repair, and defaults to zeros", async () => {
    const replies = [
      { content: '{"city":1}', usage: { prompt_tokens: 100, completion_tokens: 20 } },
      { content: '{"city":"Pittsburgh","year":2022}', usage: { prompt_tokens: 130, completion_tokens: 15 } },
    ];
    const fetch = (async () => {
      const r = replies.shift()!;
      return new Response(JSON.stringify({ choices: [{ message: { content: r.content }, finish_reason: "stop" }], usage: r.usage, model: "qwen3:8b" }));
    }) as unknown as typeof globalThis.fetch;
    const g = await new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "qwen3", fetch }).generate(req);
    expect(g.usage).toEqual({ inputTokens: 230, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(g.responseModel).toBe("qwen3:8b");

    const bare = fakeServer(['{"city":"Pittsburgh","year":2022}']);
    const g2 = await new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch: bare.fetch }).generate(req);
    expect(g2.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(g2.responseModel).toBe("m");
  });

  it("OpenAI-compatible classifies failures by kind", async () => {
    const kindOf = async (fetch: typeof globalThis.fetch) => {
      try {
        await new OpenAICompatibleLLM({ baseURL: "http://x/v1", model: "m", fetch }).generate(req);
      } catch (err) {
        return (err as LLMError).kind;
      }
      return "no error";
    };
    expect(await kindOf(fakeServer([{ status: 404, body: "nope" }]).fetch)).toBe("api_error");
    expect(await kindOf(fakeServer([{ finish: "length" }]).fetch)).toBe("truncated");
    expect(await kindOf(fakeServer(["bad", "still bad"]).fetch)).toBe("invalid");
    expect(await kindOf((async () => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch)).toBe("unreachable");
  });

  it("parseJsonOutput failures are kind invalid", () => {
    try {
      parseJsonOutput("nope", Schema);
    } catch (err) {
      expect((err as LLMError).kind).toBe("invalid");
    }
    expect.assertions(1);
  });
});

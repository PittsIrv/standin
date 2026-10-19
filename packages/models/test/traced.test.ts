import { LLMError, ScriptedLLM, type ModelProvider } from "@standin/llm";
import { MemorySink, Tracer } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TracedModel } from "../src/index.ts";

const Schema = z.object({ city: z.string() });
const req = { system: "Extract the city.", prompt: "I moved to Pittsburgh.", schema: Schema, purpose: "extract", maxTokens: 1000 };

function setup(provider: ModelProvider, prices = {}) {
  const sink = new MemorySink();
  const tracer = new Tracer({ sinks: [sink] });
  const model = new TracedModel(provider, { role: "extract", tier: "large", tracer, prices });
  return { sink, tracer, model };
}

/** A provider whose answer came from a different model than requested (a server-side fallback). */
function fallbackProvider(): ModelProvider {
  const inner = new ScriptedLLM(() => ({ city: "Pittsburgh" }), {
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 500 },
  });
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    generateObject: (r) => inner.generateObject(r),
    generate: async (r) => ({ ...(await inner.generate(r)), responseModel: "claude-opus-5" }),
  };
}

describe("TracedModel", () => {
  it("records a GenAI client span with usage, cost by response model, and content", async () => {
    const { sink, tracer, model } = setup(fallbackProvider());
    const out = await tracer.run("compaction", {}, async () => model.generateObject(req));
    expect(out).toEqual({ city: "Pittsburgh" });
    const chat = sink.spans.find((s) => s.span.name.startsWith("chat"))!;
    expect(chat.span.name).toBe("chat claude-opus-5-5");
    expect(chat.span.kind).toBe("client");
    // Opus 5 (the responder) prices: in 5, out 25, cache write 6.25, cache read 0.50.
    const cost = (1000 * 5 + 100 * 25 + 500 * 6.25 + 2000 * 0.5) / 1e6;
    expect(chat.span.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-5-5",
      "gen_ai.response.model": "claude-opus-5",
      "gen_ai.request.max_tokens": 1000,
      "gen_ai.output.type": "json",
      // Per the Anthropic conventions, input tokens include cache reads and writes.
      "gen_ai.usage.input_tokens": 3500,
      "gen_ai.usage.output_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 2000,
      "gen_ai.usage.cache_write.input_tokens": 500,
      "standin.role": "extract",
      "standin.tier": "large",
      "standin.purpose": "extract",
      "standin.batch": false,
      "standin.outcome": "ok",
    });
    expect(chat.span.attributes["standin.cost_usd"]).toBeCloseTo(cost, 10);
    expect(chat.content).toEqual({ system: "Extract the city.", prompt: "I moved to Pittsburgh.", output: { city: "Pittsburgh" } });
    expect(chat.span.parentSpanId).not.toBeNull();
  });

  it("leaves cost unset for an unknown price", async () => {
    const { sink, model } = setup(new ScriptedLLM(() => ({ city: "x" })));
    await model.generateObject(req);
    expect(sink.spans[0]!.span.attributes["standin.cost_usd"]).toBeUndefined();
    expect(sink.spans[0]!.span.attributes["gen_ai.provider.name"]).toBe("scripted");
  });

  it("records failures by kind and rethrows the original error", async () => {
    const refusing: ModelProvider = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      generateObject: async () => Promise.reject(new LLMError("refusal", "model refused (cyber)")),
      generate: async () => Promise.reject(new LLMError("refusal", "model refused (cyber)")),
    };
    const { sink, model } = setup(refusing);
    const err = await model.generateObject(req).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe("refusal");
    const span = sink.spans[0]!;
    expect(span.span.status).toEqual({ code: "error", message: "model refused (cyber)" });
    expect(span.span.attributes).toMatchObject({ "standin.outcome": "refusal", "error.type": "refusal" });
    expect(span.content).toEqual({ system: "Extract the city.", prompt: "I moved to Pittsburgh.", error: "model refused (cyber)" });
  });

  it("records one span per batch result, started at submission and priced at the batch rate", async () => {
    const provider = new ScriptedLLM((r) => (r.prompt === "bad" ? { nope: 1 } : { city: "Pittsburgh" }), { usage: { inputTokens: 1_000_000 } });
    const sink = new MemorySink();
    const tracer = new Tracer({ sinks: [sink] });
    const model = new TracedModel(provider, { role: "extract", tier: "large", tracer, prices: { scripted: { inputPerMTok: 4, outputPerMTok: 20 } } });
    expect(model.batchCapable).toBe(true);
    const id = await model.submitBatch([
      { id: "a", req: { ...req, prompt: "good" } },
      { id: "b", req: { ...req, prompt: "bad" } },
    ]);
    const results = await tracer.run("compaction", {}, async () => model.batchResults(id, Schema, { submittedAt: "2026-10-06T00:00:00.000Z" }));
    expect(results.get("a")).toMatchObject({ ok: true });
    expect(results.get("b")).toMatchObject({ ok: false, kind: "invalid" });
    const chats = sink.spans.filter((s) => s.span.name.startsWith("chat"));
    expect(chats.map((c) => [c.span.startTime, c.span.attributes["standin.batch"], c.span.attributes["standin.outcome"]])).toEqual([
      ["2026-10-06T00:00:00.000Z", true, "ok"],
      ["2026-10-06T00:00:00.000Z", true, "invalid"],
    ]);
    expect(chats[0]!.span.attributes["standin.batch_id"]).toBe(id);
    expect(chats[0]!.span.attributes["standin.cost_usd"]).toBeCloseTo(2);
    expect(chats[1]!.span.status.code).toBe("error");
  });

  it("reports whether the provider can batch", () => {
    const { model } = setup({ provider: "openai-compatible", model: "m", generateObject: async () => ({}) as never, generate: async () => ({}) as never });
    expect(model.batchCapable).toBe(false);
    return expect(model.submitBatch([])).rejects.toThrow(/batch API/);
  });
});

import { ScriptedLLM, type ModelProvider } from "@standin/llm";
import { parseConfig, type ModelRef } from "@standin/schema";
import { MemorySink, Tracer } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createModels } from "../src/index.ts";

describe("createModels", () => {
  const config = parseConfig({
    persona: { name: "X" },
    models: { roles: { reconcile: { provider: "openai-compatible", model: "qwen3:8b", baseURL: "http://localhost:11434/v1" } } },
  });

  it("resolves roles through tiers and overrides, building each distinct provider once", async () => {
    const built: ModelRef[] = [];
    const sink = new MemorySink();
    const models = createModels({
      config,
      env: {},
      tracer: new Tracer({ sinks: [sink] }),
      providerFor: (_role, ref) => {
        built.push(ref);
        const p = new ScriptedLLM(() => ({ ok: true }));
        return Object.assign(p, { model: ref.model }) as ModelProvider;
      },
    });
    await models.for("extract").generateObject({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    await models.for("reconcile").generateObject({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    models.for("style"); // large tier again: same provider as extract
    models.for("extract");
    expect(built.map((r) => r.model)).toEqual(["claude-opus-5-5", "qwen3:8b"]);
    expect(sink.spans.map((s) => [s.span.attributes["standin.role"], s.span.attributes["standin.tier"]])).toEqual([
      ["extract", "large"],
      ["reconcile", "override"],
    ]);
  });

  it("fails on first use of a role whose API key env var is missing, not at construction", () => {
    const withKey = parseConfig({ persona: { name: "X" }, models: { tiers: { large: { model: "claude-opus-5-5", apiKeyEnv: "STANDIN_NO_SUCH_KEY" } } } });
    const models = createModels({ config: withKey, env: {}, tracer: new Tracer({ sinks: [] }) });
    expect(() => models.for("reconcile")).not.toThrow();
    expect(() => models.for("extract")).toThrow(/STANDIN_NO_SUCH_KEY is not set/);
  });
});

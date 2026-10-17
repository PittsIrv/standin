import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LLMError, ScriptedLLM } from "../src/index.ts";

const Schema = z.object({ answer: z.number() });

describe("ScriptedLLM", () => {
  it("returns handler output validated against the schema", async () => {
    const llm = new ScriptedLLM((req) => ({ answer: req.prompt.length }));
    await expect(llm.generateObject({ system: "s", prompt: "abc", schema: Schema })).resolves.toEqual({ answer: 3 });
    expect(llm.calls).toHaveLength(1);
  });

  it("throws LLMError when the handler output does not match", async () => {
    const llm = new ScriptedLLM(() => ({ answer: "nope" }));
    await expect(llm.generateObject({ system: "s", prompt: "p", schema: Schema })).rejects.toBeInstanceOf(LLMError);
  });

  it("wraps handler exceptions as LLMError", async () => {
    const llm = new ScriptedLLM(() => {
      throw new Error("boom");
    });
    await expect(llm.generateObject({ system: "s", prompt: "p", schema: Schema })).rejects.toThrow(/boom/);
  });
});

describe("ScriptedLLM.generate", () => {
  it("reports configured usage and the scripted response model", async () => {
    const llm = new ScriptedLLM(() => ({ answer: 1 }), { usage: { inputTokens: 5 } });
    await expect(llm.generate({ system: "s", prompt: "p", schema: Schema })).resolves.toEqual({
      output: { answer: 1 },
      usage: { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      responseModel: "scripted",
    });
    expect(llm.provider).toBe("scripted");
    expect(llm.model).toBe("scripted");
  });
});

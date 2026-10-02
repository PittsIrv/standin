import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicLLM } from "../src/index.ts";

const live = process.env.STANDIN_LIVE === "1";

describe.skipIf(!live)("AnthropicLLM (live)", () => {
  it("returns a schema-valid object", async () => {
    const llm = new AnthropicLLM({ model: process.env.STANDIN_LIVE_MODEL ?? "claude-opus-5-5" });
    const out = await llm.generateObject({
      system: "Extract the city.",
      prompt: "I moved to Pittsburgh in 2022 for school.",
      schema: z.object({ city: z.string() }),
    });
    expect(out.city.toLowerCase()).toContain("pittsburgh");
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAICompatibleLLM } from "../src/index.ts";

// e.g. STANDIN_LIVE_LOCAL_URL=http://localhost:11434/v1 STANDIN_LIVE_LOCAL_MODEL=qwen3:8b pnpm test
const baseURL = process.env.STANDIN_LIVE_LOCAL_URL;
const model = process.env.STANDIN_LIVE_LOCAL_MODEL;

describe.skipIf(!baseURL || !model)("OpenAICompatibleLLM (live local model)", () => {
  it("returns a schema-valid object for a bilingual prompt", async () => {
    const llm = new OpenAICompatibleLLM({ baseURL: baseURL!, model: model! });
    const out = await llm.generateObject({
      system: "Extract the city the person moved to, in English.",
      prompt: "我2022年搬到了Pittsburgh读书。",
      schema: z.object({ city: z.string(), year: z.number().nullable() }),
    });
    expect(out.city.toLowerCase()).toContain("pittsburgh");
  }, 600_000);
});

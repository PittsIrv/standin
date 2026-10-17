import { AnthropicLLM } from "@standin/llm";
import { parseConfig, type Observation } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { extractionRequest, ExtractionSchema } from "../src/index.ts";

const live = process.env.STANDIN_LIVE === "1";

// A standing check that extraction's system prompt is long enough to cache (512 tokens on
// Opus/Sonnet 5.5): a later edit that shortens it, or adds anything per-call, fails this.
describe.skipIf(!live)("extraction prompt caching (live)", () => {
  it("reads the system prompt from the cache on a second call", async () => {
    const config = parseConfig({ persona: { name: "Lin Qiao" } });
    const llm = new AnthropicLLM({ model: process.env.STANDIN_LIVE_MODEL ?? "claude-opus-5-5" });
    const observation = (text: string): Observation => ({
      id: "obs_000000000001",
      sourceKind: "interview",
      sourceRef: "live-test",
      authorRole: "self",
      lang: "en",
      text,
      contentHash: "x",
      occurredAt: "2026-10-07T00:00:00.000Z",
      ingestedAt: "2026-10-07T00:00:00.000Z",
      compactedAt: null,
      compactionResult: null,
      purgedAt: null,
      meta: {},
    });
    const first = await llm.generate({ ...extractionRequest(observation("Q: Where do you live?\n\nA: Pittsburgh."), config), schema: ExtractionSchema });
    const second = await llm.generate({ ...extractionRequest(observation("Q: What do you build?\n\nA: Board-game AIs."), config), schema: ExtractionSchema });
    expect(first.usage.cacheWriteTokens + first.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  }, 300_000);
});

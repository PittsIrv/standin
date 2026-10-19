import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_PRICES, priceFor } from "../src/index.ts";

const usage = (u: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...u,
});

describe("pricing", () => {
  it("prices input, output, cache reads and cache writes per MTok", () => {
    const price = { inputPerMTok: 2, outputPerMTok: 10 };
    expect(costUsd(usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), price, { batch: false })).toBeCloseTo(12);
    // Without explicit cache prices: reads at 0.1x input, 5-minute writes at 1.25x.
    expect(costUsd(usage({ cacheReadTokens: 1_000_000 }), price, { batch: false })).toBeCloseTo(0.2);
    expect(costUsd(usage({ cacheWriteTokens: 1_000_000 }), price, { batch: false })).toBeCloseTo(2.5);
    // Explicit cache prices win.
    expect(costUsd(usage({ cacheReadTokens: 1_000_000 }), { ...price, cacheReadPerMTok: 0.05 }, { batch: false })).toBeCloseTo(0.05);
  });

  it("halves everything in a batch, and has no cost without a price", () => {
    const price = { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.2, cacheWritePerMTok: 5 };
    const u = usage({ inputTokens: 500_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 200_000 });
    expect(costUsd(u, price, { batch: true })).toBeCloseTo((2 + 2 + 0.2 + 1) / 2);
    expect(costUsd(u, null, { batch: false })).toBeNull();
  });

  it("ships verified prices for the default tiers, with per-model cache reads", () => {
    expect(DEFAULT_PRICES["claude-opus-5-5"]).toEqual({ inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 });
    expect(DEFAULT_PRICES["claude-haiku-4-5"]).toEqual({ inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 });
    expect(DEFAULT_PRICES["claude-sonnet-5-5"]?.inputPerMTok).toBe(2);
  });

  it("finds a price by dated id, and lets config override it", () => {
    expect(priceFor("claude-haiku-4-5-20251001", {})).toEqual(DEFAULT_PRICES["claude-haiku-4-5"]);
    expect(priceFor("qwen3:8b", {})).toBeNull();
    expect(priceFor("qwen3:8b", { "qwen3:8b": { inputPerMTok: 0, outputPerMTok: 0 } })).toEqual({ inputPerMTok: 0, outputPerMTok: 0 });
    expect(priceFor("claude-opus-5-5", { "claude-opus-5-5": { inputPerMTok: 1, outputPerMTok: 1 } })?.inputPerMTok).toBe(1);
  });
});

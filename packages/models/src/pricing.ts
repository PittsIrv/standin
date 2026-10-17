import type { Usage } from "@standin/llm";
import type { Price } from "@standin/schema";

/**
 * USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
 * (checked 2026-10-07). Cache writes are the 5-minute rate, which is what our
 * `cache_control: ephemeral` system prompts use. Keys are model ids without a
 * date suffix. Unlisted models have no price; their calls report a null cost.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-fable-5-1": { inputPerMTok: 10, outputPerMTok: 50, cacheWritePerMTok: 12.5, cacheReadPerMTok: 0.25 },
  "claude-opus-5-5": { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
  // The page's model table lists $0.20 cache reads for Sonnet 5.5 while its caching section says $0.10;
  // we take the higher figure so reported cost never understates the bill.
  "claude-sonnet-5-5": { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
};

/** Applied when a price doesn't list cache rates (e.g. a user override). */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
/** The Batch API discount applies to every token type, cache reads and writes included. */
export const BATCH_MULTIPLIER = 0.5;

/** Config overrides first, then the built-in table; a dated id (claude-haiku-4-5-20251001) also matches its undated key. */
export function priceFor(model: string, overrides: Record<string, Price>): Price | null {
  const undated = model.replace(/-\d{8}$/, "");
  return overrides[model] ?? overrides[undated] ?? DEFAULT_PRICES[model] ?? DEFAULT_PRICES[undated] ?? null;
}

/** `usage.inputTokens` is uncached input; cache reads and writes are priced separately. */
export function costUsd(usage: Usage, price: Price | null, opts: { batch: boolean }): number | null {
  if (!price) return null;
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok * CACHE_READ_MULTIPLIER;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok * CACHE_WRITE_MULTIPLIER;
  const dollars =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cacheReadTokens * cacheRead +
      usage.cacheWriteTokens * cacheWrite) /
    1_000_000;
  return opts.batch ? dollars * BATCH_MULTIPLIER : dollars;
}

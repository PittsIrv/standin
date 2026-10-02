import { createHash } from "node:crypto";

/** NFKC, trimmed, whitespace collapsed. Used for content hashing. */
export function normalizeText(s: string): string {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Aggressive key for matching names: NFKC, lowercase, no punctuation, symbols or whitespace. */
export function normalizeName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

/** Character bigrams of the name-normalized string; a lone character is its own gram. */
export function bigrams(s: string): Set<string> {
  const chars = [...normalizeName(s)];
  if (chars.length === 1) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i++) grams.add(chars[i]! + chars[i + 1]!);
  return grams;
}

/** Sørensen–Dice similarity over character bigrams. Works for CJK and Latin text alike. */
export function dice(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return (2 * shared) / (ga.size + gb.size);
}

export function contentHash(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(`${p.length}:${p}`);
  return h.digest("hex");
}

import type { MemoryKind } from "@standin/schema";

export type Novelty = "new" | "update" | "contradiction";

export const KIND_WEIGHTS: Record<MemoryKind, number> = { fact: 1, competence: 1, stance: 0.9, negative: 0.8 };
export const NOVELTY_WEIGHTS: Record<Novelty, number> = { new: 1, update: 0.8, contradiction: 1.2 };

/** How much a proposed memory deserves the person's limited review attention. */
export function salience(input: { kind: MemoryKind; confidence: number; novelty: Novelty; demandHits?: number }): number {
  return KIND_WEIGHTS[input.kind] * (0.5 + 0.5 * input.confidence) * NOVELTY_WEIGHTS[input.novelty] * (1 + (input.demandHits ?? 0));
}

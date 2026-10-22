import type { TreeSnapshot } from "./snapshot.ts";

/** What a node's lighting is, from the person's own words or from probes. */
export interface RuleValue {
  depth: number;
  basis: "claimed" | "predicted" | "probed" | "stated";
  reasons: string[];
}

/** The depth a background guess takes when the model gives none. */
export const SEED_DEPTH = 2;

/**
 * Lighting comes only from what the person said or showed: their claims, their concept-card answers (`stated`, which
 * win), approved probed lighting, and confirmed hypotheses. Guesses (seeding, parts, prerequisites) are hypotheses now: probable, not lit, until probed.
 * A probe outranks a claim on the same node only where the claim is absent.
 */
export function computeLighting(t: TreeSnapshot): Map<string, RuleValue> {
  const values = new Map<string, RuleValue>();
  for (const [node, depth] of t.claims) if (t.topics.has(node)) values.set(node, { depth, basis: "claimed", reasons: [`you claimed ${depth}`] });
  for (const [node, lit] of t.approved)
    if (lit.basis === "probed" && t.topics.has(node)) values.set(node, { depth: lit.depth, basis: "probed", reasons: [`probed at ${lit.depth}`] });
  for (const [node, depth] of t.confirmedHypotheses) {
    if (!t.topics.has(node) || values.has(node)) continue;
    const h = [...t.hypotheses.values()].find((x) => x.depth === depth);
    values.set(node, { depth, basis: "probed", reasons: [`a probe confirmed ${depth}${h ? ` (${h.kind})` : ""}`] });
  }
  // A card answer is the person's latest word on the node, so it wins.
  for (const [node, depth] of t.stated) if (t.topics.has(node)) values.set(node, { depth, basis: "stated", reasons: [`you said ${depth}`] });
  return values;
}

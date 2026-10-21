import type { TreeSnapshot } from "./snapshot.ts";

/** What a node's lighting is, from the person's own words or from probes. */
export interface RuleValue {
  depth: number;
  basis: "claimed" | "predicted" | "probed";
  reasons: string[];
}

/** The depth a background seeds its field and core topics at, as hypotheses. */
export const SEED_DEPTH = 2;

/**
 * Lighting comes only from what the person said or showed: their claims, approved probed lighting, and hypotheses a
 * usable probe confirmed. Guesses (seeding, parts, prerequisites) are hypotheses now: probable, not lit, until probed.
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
  return values;
}

import type { TreeSnapshot } from "./snapshot.ts";

/** What the rules say a node's lighting should be. Claims come straight from the person; the rest is inferred. */
export interface RuleValue {
  depth: number;
  basis: "claimed" | "predicted" | "probed";
  reasons: string[];
}

/** The background floor for a seeded core topic. */
export const SEED_DEPTH = 2;
/** Inference never predicts more than "strong"; expert needs the person's word or probes. */
const INFERENCE_CAP = 3;

/**
 * Claims, background seeding, upward inference (a parent is at least one below its strongest child) and
 * prerequisite inference (a foundation is at least one below what needs it), iterated to a fixpoint.
 * Inference only raises: the highest of the claim and every inferred floor wins.
 */
export function computeLighting(t: TreeSnapshot): Map<string, RuleValue> {
  const name = (id: string) => t.topics.get(id)?.name ?? id;
  const values = new Map<string, RuleValue>();
  for (const [node, depth] of t.claims) if (t.topics.has(node)) values.set(node, { depth, basis: "claimed", reasons: [`you claimed ${depth}`] });
  // Probed lighting is measured, so inference never overrides it.
  for (const [node, lit] of t.approved)
    if (lit.basis === "probed" && t.topics.has(node)) values.set(node, { depth: lit.depth, basis: "probed", reasons: [`probed at ${lit.depth}`] });

  const raise = (node: string, depth: number, reason: string): boolean => {
    if (!t.topics.has(node)) return false;
    const current = values.get(node);
    if (current?.basis === "probed" || (current && current.depth >= depth)) return false;
    values.set(node, { depth, basis: "predicted", reasons: current ? [...current.reasons, reason] : [reason] });
    return true;
  };

  for (const [node, background] of t.seeded) raise(node, SEED_DEPTH, `core of your background: ${background}`);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [child, value] of [...values]) {
      const parent = t.parentOf.get(child);
      if (parent && value.depth >= 1) {
        changed = raise(parent, Math.min(value.depth - 1, INFERENCE_CAP), `${name(child)} is at ${value.depth} and is part of it`) || changed;
      }
    }
    for (const [advanced, foundation] of t.requires) {
      const value = values.get(advanced);
      if (value && value.depth >= 1) {
        changed = raise(foundation, Math.min(value.depth - 1, INFERENCE_CAP), `needed for ${name(advanced)} (${value.depth})`) || changed;
      }
    }
  }
  return values;
}

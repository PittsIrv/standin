import type { Gap } from "@standin/schema";
import type { Store } from "@standin/store";
import type { RuleValue } from "./lighting.ts";
import type { TreeSnapshot } from "./snapshot.ts";

/** A stated limit sits at "heard of it, haven't used it". */
export const STATED_GAP_LEVEL = 1;

/**
 * The person's own "I can't do X" counts like a confirmed probe miss: an approved negative whose topic sits
 * under a lit node becomes a kept gap at level 1. A node counts as lit once it is approved, or as soon as the
 * rules light it (`values`), so the gap is in place before that lighting is approved. Negatives with no lit
 * ancestor stay plain negatives.
 */
export function syncStatedGaps(store: Store, t: TreeSnapshot, values: Map<string, RuleValue> = new Map()): Gap[] {
  const created: Gap[] = [];
  for (const negative of t.negatives) {
    for (const nodeId of negative.topicIds) {
      const litAncestor = ancestors(t, nodeId).find((a) => (t.approved.get(a)?.depth ?? 0) >= 1 || (values.get(a)?.depth ?? 0) >= 1);
      if (!litAncestor) continue;
      const gap = store.addGap({
        nodeId,
        claimNodeId: litAncestor,
        level: STATED_GAP_LEVEL,
        status: "kept",
        source: "stated",
        memoryId: negative.memoryId,
      });
      if (gap) created.push(gap);
    }
  }
  return created;
}

function ancestors(t: TreeSnapshot, nodeId: string): string[] {
  const out: string[] = [];
  for (let n = t.parentOf.get(nodeId); n !== undefined && !out.includes(n) && n !== nodeId; n = t.parentOf.get(n)) out.push(n);
  return out;
}

import type { Store } from "@standin/store";
import type { RuleValue } from "./lighting.ts";
import type { TreeSnapshot } from "./snapshot.ts";
import { statementFor } from "./wording.ts";

export interface ProposalReport {
  /** Ids of new lighting proposals. */
  proposed: string[];
  /** Ids of pending proposals rejected because a newer estimate replaced them. */
  replaced: string[];
  unchanged: number;
}

/**
 * Turns rule values into proposals for review. Only inferred values are proposed (a claim is already the
 * person's word), only when they exceed what is approved, and never twice: a pending or rejected proposal
 * for the same node and depth stops it. A pending proposal at another depth is replaced.
 */
export function proposeLighting(store: Store, t: TreeSnapshot, values: Map<string, RuleValue>): ProposalReport {
  const report: ProposalReport = { proposed: [], replaced: [], unchanged: 0 };
  store.transaction(() => {
    for (const [nodeId, value] of values) {
      if (value.basis !== "predicted") continue;
      const out = proposeNode(store, t, nodeId, value.depth, "predicted", value.reasons);
      if (out.proposed) report.proposed.push(out.proposed);
      else report.unchanged++;
      report.replaced.push(...out.replaced);
    }
  });
  return report;
}

/**
 * One lighting proposal, by the §3.6 rules: only above what is approved, never twice for the same node and
 * depth (pending or rejected), and replacing a pending proposal at another depth.
 */
export function proposeNode(
  store: Store,
  t: TreeSnapshot,
  nodeId: string,
  depth: number,
  basis: "predicted" | "probed",
  reasons: string[],
): { proposed: string | null; replaced: string[] } {
  const approved = t.approved.get(nodeId);
  const decided = t.proposals.some((p) => p.nodeId === nodeId && p.depth === depth);
  if ((approved && approved.depth >= depth) || decided) return { proposed: null, replaced: [] };
  const replaced: string[] = [];
  for (const stale of t.proposals.filter((p) => p.nodeId === nodeId && p.status === "proposed")) {
    store.reject(stale.memoryId, "replaced by a newer estimate", "map");
    replaced.push(stale.memoryId);
  }
  const topic = t.topics.get(nodeId)!;
  const previous = approved ? store.getMemory(approved.memoryId) : null;
  // Approved lighting covers the branch below it, so say how far before the person approves.
  const parts = descendants(t, nodeId);
  const why = parts > 0 ? [...reasons, `Approving lights its whole branch: ${parts} part${parts === 1 ? "" : "s"} in the tree.`] : reasons;
  const m = store.insertMemory(
    {
      kind: "competence",
      statement: statementFor(depth, topic.name),
      tier: previous?.tier ?? 1,
      isCurrentState: false,
      attrs: { domain: topic.name, depth, basis, reasons: why },
      supersedesId: approved?.memoryId ?? null,
    },
    { sourceObservationIds: [], entityIds: [nodeId], actor: "map" },
  );
  return { proposed: m.id, replaced };
}
/** How many nodes sit below `nodeId` in the part_of tree. */
function descendants(t: TreeSnapshot, nodeId: string): number {
  const children = new Map<string, string[]>();
  for (const [child, parent] of t.parentOf) children.set(parent, [...(children.get(parent) ?? []), child]);
  let count = 0;
  const seen = new Set<string>([nodeId]);
  const stack = [...(children.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    count++;
    stack.push(...(children.get(n) ?? []));
  }
  return count;
}

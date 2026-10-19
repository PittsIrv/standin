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
      const approved = t.approved.get(nodeId);
      const decided = t.proposals.some((p) => p.nodeId === nodeId && p.depth === value.depth);
      if ((approved && approved.depth >= value.depth) || decided) {
        report.unchanged++;
        continue;
      }
      for (const stale of t.proposals.filter((p) => p.nodeId === nodeId && p.status === "proposed")) {
        store.reject(stale.memoryId, "replaced by a newer estimate", "map");
        report.replaced.push(stale.memoryId);
      }
      const topic = t.topics.get(nodeId)!;
      const previous = approved ? store.getMemory(approved.memoryId) : null;
      const m = store.insertMemory(
        {
          kind: "competence",
          statement: statementFor(value.depth, topic.name),
          tier: previous?.tier ?? 1,
          isCurrentState: false,
          attrs: { domain: topic.name, depth: value.depth, basis: "predicted", reasons: value.reasons },
          supersedesId: approved?.memoryId ?? null,
        },
        { sourceObservationIds: [], entityIds: [nodeId], actor: "map" },
      );
      report.proposed.push(m.id);
    }
  });
  return report;
}

import type { DepthBasis, Gap, Probe, Topic } from "@standin/schema";
import type { Store } from "@standin/store";

/** Everything the lighting rules and the answering rule read, loaded once. Deleted topics are left out. */
export interface TreeSnapshot {
  topics: Map<string, Topic>;
  /** part_of: child → parent. */
  parentOf: Map<string, string>;
  /** requires: [advanced, foundation]. */
  requires: [string, string][];
  /** The latest approved competence memory per node: what the runtime uses. No basis means the person claimed it. */
  approved: Map<string, { depth: number; basis: DepthBasis; memoryId: string }>;
  /** Approved claims in the person's own words, per node. */
  claims: Map<string, number>;
  /** Background-seeded core topics → the background statement that seeded them. */
  seeded: Map<string, string>;
  gaps: Gap[];
  /** Approved negative memories and the topic nodes they name. */
  negatives: { memoryId: string; topicIds: string[] }[];
  /** Lighting proposals the knowledge map wrote, pending or rejected. */
  proposals: { nodeId: string; depth: number; status: "proposed" | "rejected"; memoryId: string }[];
  /** Inferred nodes a usable foundation probe confirmed ("know", no failed spot-check). */
  confirmed: Set<string>;
}

export function loadSnapshot(store: Store): TreeSnapshot {
  const topics = new Map(store.listTopics().map((t) => [t.id, t]));
  const parentOf = new Map<string, string>();
  for (const e of store.listEdges("part_of")) if (!parentOf.has(e.from)) parentOf.set(e.from, e.to);
  const requires = store.listEdges("requires").map((e) => [e.from, e.to] as [string, string]);

  const approved: TreeSnapshot["approved"] = new Map();
  const claims = new Map<string, number>();
  const proposals: TreeSnapshot["proposals"] = [];
  const seeded = new Map<string, string>();
  for (const t of topics.values()) {
    const competence = store.topicMemories(t.id, { kind: "competence" });
    for (const m of competence) {
      if (m.kind !== "competence") continue;
      if (m.status === "approved") {
        approved.set(t.id, { depth: m.attrs.depth, basis: m.attrs.basis ?? "claimed", memoryId: m.id });
        if (!m.attrs.basis) claims.set(t.id, m.attrs.depth);
      } else if (m.attrs.basis && (m.status === "proposed" || m.status === "rejected")) {
        proposals.push({ nodeId: t.id, depth: m.attrs.depth, status: m.status, memoryId: m.id });
      }
    }
    if (t.seedMemoryId) seeded.set(t.id, store.getMemory(t.seedMemoryId).statement);
  }

  const negatives = store.listMemories({ status: "approved", kind: "negative" }).map((m) => ({
    memoryId: m.id,
    topicIds: store.memoryEntities(m.id).filter((e) => e.kind === "topic" && topics.has(e.id)).map((e) => e.id),
  }));

  return {
    topics,
    parentOf,
    requires,
    approved,
    claims,
    seeded,
    gaps: store.listGaps().filter((g) => topics.has(g.nodeId)),
    negatives,
    proposals,
    confirmed: new Set(
      store
        .listResponses({ rated: true })
        .filter((r) => r.probe.kind === "foundation" && r.rating === "know" && r.grade !== "fail" && usableProbe(r.probe))
        .map((r) => r.probe.nodeId),
    ),
  };
}

/** Held-out probes feed the map only once released, and fixed ones never (spec §4.8). */
export const usableProbe = (p: Probe): boolean => p.holdout === "none" || (p.holdout === "rotating" && p.releasedAt !== null);

import type { DepthBasis, Gap, Probe, RootKey, Topic } from "@standin/schema";
import type { Store } from "@standin/store";

/** Everything the lighting rules and the answering rule read, loaded once. Deleted nodes are left out. */
export interface TreeSnapshot {
  /** Knowledge nodes only: lighting, probing and the answering rule work inside the Knowledge root. */
  topics: Map<string, Topic>;
  /** Every live node except the roots, in any root. */
  all: Map<string, Topic>;
  /** Root node id → its key. */
  roots: Map<string, RootKey>;
  /** Each node's root, following home parents; null while unplaced. */
  rootOf: Map<string, RootKey | null>;
  /** Ids of `topics`: nodes under Knowledge, plus unplaced nodes labeled `topic`. */
  knowledge: Set<string>;
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
  const all = new Map(store.listTopics().map((t) => [t.id, t]));
  const roots = new Map(store.roots().map((r) => [r.id, r.rootKey!]));
  const parentOf = new Map<string, string>();
  for (const e of store.listEdges("part_of")) if (!parentOf.has(e.from)) parentOf.set(e.from, e.to);
  const rootOf = new Map<string, RootKey | null>();
  for (const id of all.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = id;
    while (at !== undefined && !roots.has(at) && !seen.has(at)) {
      seen.add(at);
      at = parentOf.get(at);
    }
    rootOf.set(id, at !== undefined ? (roots.get(at) ?? null) : null);
  }
  const knowledge = new Set([...all.values()].filter((t) => rootOf.get(t.id) === "knowledge" || (rootOf.get(t.id) === null && t.label === "topic")).map((t) => t.id));
  const topics = new Map([...all].filter(([id]) => knowledge.has(id)));
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
    all,
    roots,
    rootOf,
    knowledge,
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

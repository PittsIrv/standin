import type { Topic } from "@standin/schema";
import type { TreeSnapshot } from "../src/index.ts";

const topic = (id: string): Topic => ({
  id,
  name: id,
  aliases: [],
  label: "topic",
  rootKey: null,
  frontier: false,
  partLevel: null,
  walkStopped: false,
  definition: null,
  examples: [],
  expandedAt: null,
  seedMemoryId: null,
  boundaryTier: null,
  deletedAt: null,
});

/** A tree snapshot built in code: names double as ids. */
export function tree(spec: {
  partOf?: [string, string][];
  requires?: [string, string][];
  claims?: Record<string, number>;
  approved?: Record<string, { depth: number; basis: "claimed" | "predicted" | "probed" }>;
  seeded?: Record<string, string>;
  gaps?: { node: string; level: number }[];
  boundaries?: string[];
  hypotheses?: Record<string, { depth: number; p: number }>;
  confirmedHypotheses?: Record<string, number>;
  /** Nodes outside the Knowledge root (Life). */
  life?: string[];
  /** Nodes named by an approved "I don't know X". */
  negatives?: string[];
  /** Concept-card answers: node → level. */
  stated?: Record<string, number>;
}): TreeSnapshot {
  const names = new Set<string>();
  for (const [a, b] of [...(spec.partOf ?? []), ...(spec.requires ?? [])]) names.add(a).add(b);
  for (const n of [...Object.keys(spec.claims ?? {}), ...Object.keys(spec.approved ?? {}), ...Object.keys(spec.seeded ?? {})]) names.add(n);
  for (const g of spec.gaps ?? []) names.add(g.node);
  for (const n of [...Object.keys(spec.hypotheses ?? {}), ...Object.keys(spec.confirmedHypotheses ?? {}), ...(spec.negatives ?? []), ...Object.keys(spec.stated ?? {})])
    names.add(n);
  const topics = new Map([...names].map((n) => [n, { ...topic(n), boundaryTier: spec.boundaries?.includes(n) ? (3 as const) : null }]));
  const all = new Map<string, Topic>([...topics, ...(spec.life ?? []).map((n): [string, Topic] => [n, { ...topic(n), label: "pet" }])]);
  const claims = new Map(Object.entries(spec.claims ?? {}));
  const approved = new Map(
    Object.entries({
      ...Object.fromEntries([...claims].map(([n, d]) => [n, { depth: d, basis: "claimed" as const }])),
      ...(spec.approved ?? {}),
    }).map(([n, v]) => [n, { ...v, memoryId: `mem_${n}` }]),
  );
  return {
    topics,
    all,
    roots: new Map(),
    rootOf: new Map([...all.keys()].map((n) => [n, (spec.life ?? []).includes(n) ? ("life" as const) : null])),
    knowledge: new Set(topics.keys()),
    homeFacts: new Map(),
    stated: new Map(Object.entries(spec.stated ?? {})),
    hypotheses: new Map(
      Object.entries(spec.hypotheses ?? {}).map(([n, h]) => [n, { id: `hyp_${n}`, depth: h.depth, p: h.p, kind: "part", rawScore: "medium", reason: "r" }]),
    ),
    confirmedHypotheses: new Map(Object.entries(spec.confirmedHypotheses ?? {})),
    parentOf: new Map(spec.partOf ?? []),
    requires: spec.requires ?? [],
    approved,
    claims,
    seeded: new Map(Object.entries(spec.seeded ?? {})),
    gaps: (spec.gaps ?? []).map((g, i) => ({
      id: `gap_${i}`,
      nodeId: g.node,
      claimNodeId: null,
      level: g.level,
      status: "kept" as const,
      source: "stated" as const,
      memoryId: null,
      responseId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    })),
    negatives: (spec.negatives ?? []).map((n, i) => ({ memoryId: `mem_neg_${i}`, topicIds: [n] })),
    proposals: [],
    confirmed: new Set(),
  };
}

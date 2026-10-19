import type { Topic } from "@standin/schema";
import type { TreeSnapshot } from "../src/index.ts";

const topic = (id: string): Topic => ({
  id,
  name: id,
  aliases: [],
  definition: null,
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
}): TreeSnapshot {
  const names = new Set<string>();
  for (const [a, b] of [...(spec.partOf ?? []), ...(spec.requires ?? [])]) names.add(a).add(b);
  for (const n of [...Object.keys(spec.claims ?? {}), ...Object.keys(spec.approved ?? {}), ...Object.keys(spec.seeded ?? {})]) names.add(n);
  for (const g of spec.gaps ?? []) names.add(g.node);
  const topics = new Map([...names].map((n) => [n, { ...topic(n), boundaryTier: spec.boundaries?.includes(n) ? (3 as const) : null }]));
  const claims = new Map(Object.entries(spec.claims ?? {}));
  const approved = new Map(
    Object.entries({
      ...Object.fromEntries([...claims].map(([n, d]) => [n, { depth: d, basis: "claimed" as const }])),
      ...(spec.approved ?? {}),
    }).map(([n, v]) => [n, { ...v, memoryId: `mem_${n}` }]),
  );
  return {
    topics,
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
      createdAt: "2026-10-01T00:00:00.000Z",
    })),
    negatives: [],
    proposals: [],
  };
}

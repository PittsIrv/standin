import { readFileSync } from "node:fs";
import type { EntityKind } from "@standin/schema";
import { openStore, type Store } from "@standin/store";

/** One labeled duplicate-search case: does retrieval surface `existing[expect]` for `candidate`? */
export interface DedupCase {
  id: string;
  existing: { statement: string; entities: { name: string; kind: EntityKind }[] }[];
  candidate: { statement: string; entities: { name: string; kind: EntityKind }[] };
  /** Index into `existing` of the memory it should match, or null when nothing should match. */
  expect: number | null;
  note?: string;
}

export interface RetrievalMethod {
  name: string;
  describe: string;
  retrieve(store: Store, q: { statement: string; entityIds: string[] }, k: number): string[];
}

const neighbors = (minSimilarity: number) => (store: Store, q: { statement: string; entityIds: string[] }, k: number) =>
  store.findNeighbors(q, { limit: k, minSimilarity }).map((n) => n.memory.id);

/** The retrieval methods compared. The first is what compaction uses today. */
export const METHODS: RetrievalMethod[] = [
  { name: "dice≥0.3+entity", describe: "shared entity, or character-bigram similarity ≥ 0.3 (current)", retrieve: neighbors(0.3) },
  { name: "dice-topk+entity", describe: "shared entity, plus the closest by similarity, no threshold", retrieve: neighbors(0) },
  { name: "entity-only", describe: "only memories sharing a named entity", retrieve: neighbors(Number.POSITIVE_INFINITY) },
];

export const KS = [1, 4, 8] as const;

export interface MethodReport {
  method: string;
  recall: Record<(typeof KS)[number], number>;
  /** Average number of memories sent to reconcile at k = 8, over all cases. */
  avgCandidates: number;
  /** Cases whose expected memory was not retrieved at k = 8. */
  misses: string[];
}

export function evalDedup(cases: DedupCase[], methods: RetrievalMethod[] = METHODS): MethodReport[] {
  const built = cases.map((c) => {
    const store = openStore({ path: ":memory:" });
    const ids = c.existing.map(
      (m) =>
        store.insertMemory(
          { kind: "fact", statement: m.statement, tier: 1, isCurrentState: false, attrs: {} },
          { sourceObservationIds: [], entityIds: m.entities.map((e) => store.resolveEntity(e).id), actor: "compaction" },
        ).id,
    );
    const entityIds = c.candidate.entities.map((e) => store.findEntity(e)?.id).filter((id): id is string => id !== undefined);
    return { c, store, ids, query: { statement: c.candidate.statement, entityIds } };
  });
  try {
    return methods.map((method) => {
      const labeled = built.filter((b) => b.c.expect !== null);
      const hits = (k: number) =>
        labeled.filter((b) => method.retrieve(b.store, b.query, k).includes(b.ids[b.c.expect!]!)).length / Math.max(1, labeled.length);
      const recall = Object.fromEntries(KS.map((k) => [k, hits(k)])) as MethodReport["recall"];
      const avgCandidates = built.reduce((sum, b) => sum + method.retrieve(b.store, b.query, 8).length, 0) / Math.max(1, built.length);
      const misses = labeled.filter((b) => !method.retrieve(b.store, b.query, 8).includes(b.ids[b.c.expect!]!)).map((b) => b.c.id);
      return { method: method.name, recall, avgCandidates, misses };
    });
  } finally {
    for (const b of built) b.store.close();
  }
}

/** The shipped labeled set (one JSON object per line). */
export function loadDedupCases(path: string | URL = new URL("../eval/dedup.jsonl", import.meta.url)): DedupCase[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as DedupCase);
}

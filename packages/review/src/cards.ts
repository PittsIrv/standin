import { reviewQueue, type QueueGroup, type ReviewItem } from "@standin/compaction";
import type { ClaimDecision, Miss, PendingSpotCheck, ProbeSession, ShownProbe } from "@standin/knowledge";
import type { Config, MemoryKind } from "@standin/schema";
import type { SourceSummary, Store } from "@standin/store";

/** A review-queue item as the page shows it. */
export interface QueueCard {
  id: string;
  /** A "Still true?" check on an approved current-state memory, rather than a proposal. */
  stillTrue: boolean;
  group: QueueGroup;
  memoryKind: MemoryKind;
  statement: string;
  tier: number;
  reasons: string[];
  sources: SourceSummary;
  /** The statement this one would replace, or conflicts with. */
  replaces: string | null;
  conflictsWith: string | null;
}

export type Card =
  | { type: "probe"; probe: ShownProbe }
  | { type: "spot-check"; check: PendingSpotCheck }
  | { type: "miss"; miss: Miss }
  | { type: "claim"; decision: ClaimDecision }
  | { type: "proposal"; item: QueueCard }
  | { type: "done" };

export function queueCard(store: Store, i: ReviewItem): QueueCard {
  const m = i.memory;
  return {
    id: m.id,
    stillTrue: i.kind === "still-true",
    group: i.group,
    memoryKind: m.kind,
    statement: m.statement,
    tier: m.tier,
    reasons: m.kind === "competence" ? (m.attrs.reasons ?? []) : [],
    sources: i.sources,
    replaces: m.supersedesId ? store.getMemory(m.supersedesId).statement : null,
    conflictsWith: m.conflictsWithId ? store.getMemory(m.conflictsWithId).statement : null,
  };
}

/**
 * The one card to show now, first match wins: the unrated probe (so a reload shows it again), its spot-check, a miss
 * to judge, a claim to keep or lower, a new probe, the review queue, then done (decision 38).
 */
export async function nextCard(session: ProbeSession, store: Store, config: Config): Promise<Card> {
  const current = session.current();
  if (current) return { type: "probe", probe: current };
  const check = session.pendingSpotCheck();
  if (check) return { type: "spot-check", check };
  const miss = session.pendingMisses()[0];
  if (miss) return { type: "miss", miss };
  const decision = session.pendingClaimDecisions()[0];
  if (decision) return { type: "claim", decision };
  const probe = await session.next();
  if (probe) return { type: "probe", probe };
  const item = reviewQueue(store, config)[0];
  if (item) return { type: "proposal", item: queueCard(store, item) };
  return { type: "done" };
}

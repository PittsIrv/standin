import { reviewQueue, type QueueGroup, type ReviewItem } from "@standin/compaction";
import type { CardSession, ClaimDecision, ShownCard } from "@standin/knowledge";
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
  | { type: "card"; card: ShownCard }
  | { type: "keep-lower"; decision: ClaimDecision }
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
 * The one card to show now, first match wins (concept-cards spec §4): the card on screen (so a reload shows it
 * again), a keep-or-lower decision, the next concept card, the review queue, then done.
 */
export async function nextCard(session: CardSession, store: Store, config: Config): Promise<Card> {
  const current = session.current();
  if (current) return { type: "card", card: current };
  const decision = session.keepLowerDue();
  if (decision) return { type: "keep-lower", decision };
  const card = await session.next();
  if (card) return { type: "card", card };
  const item = reviewQueue(store, config)[0];
  if (item) return { type: "proposal", item: queueCard(store, item) };
  return { type: "done" };
}

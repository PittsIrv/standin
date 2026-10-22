import type { Config, Memory } from "@standin/schema";
import type { SourceSummary, Store } from "@standin/store";

export type QueueGroup = "contradiction" | "still-true" | "update" | "new";

export interface ReviewItem {
  /** "still-true" asks whether an approved "currently…" memory still holds; "memory" is a proposal. */
  kind: "memory" | "still-true";
  group: QueueGroup;
  memory: Memory;
  sources: SourceSummary;
}

const GROUP_ORDER: Record<QueueGroup, number> = { contradiction: 0, "still-true": 1, update: 2, new: 3 };

const groupOf = (m: Memory): QueueGroup => (m.conflictsWithId ? "contradiction" : m.supersedesId ? "update" : "new");

/**
 * Everything waiting for the person, in a plain order: contradictions, "Still true?" checks,
 * updates, then new proposals. Within a group, better-supported items first, then oldest.
 */
export function reviewQueue(store: Store, config: Config): ReviewItem[] {
  const proposed: ReviewItem[] = store.listMemories({ status: "proposed" }).map((memory) => ({
    kind: "memory",
    group: groupOf(memory),
    memory,
    sources: store.memorySourceSummary(memory.id),
  }));
  const stale: ReviewItem[] = store.staleCurrentState(config.consolidation.freshnessDays).map((memory) => ({
    kind: "still-true",
    group: "still-true",
    memory,
    sources: store.memorySourceSummary(memory.id),
  }));
  return [...proposed, ...stale].sort(
    (a, b) =>
      GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
      b.sources.distinct - a.sources.distinct ||
      a.memory.recordedAt.localeCompare(b.memory.recordedAt) ||
      a.memory.id.localeCompare(b.memory.id),
  );
}

/** Where an item sits in the review queue right now, for the decision log. */
export function queuePlace(store: Store, config: Config, id: string): { group: QueueGroup | null; position: number | null } {
  const items = reviewQueue(store, config);
  const position = items.findIndex((i) => i.memory.id === id);
  return position === -1 ? { group: null, position: null } : { group: items[position]!.group, position };
}

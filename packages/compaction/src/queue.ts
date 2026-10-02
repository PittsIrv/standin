import type { Memory } from "@standin/schema";
import type { Store } from "@standin/store";

/** Proposed memories worth the person's attention this week: contradictions first, then by salience. */
export function reviewQueue(store: Store, opts: { cap: number }): Memory[] {
  return store
    .listMemories({ status: "proposed" })
    .sort(
      (a, b) =>
        Number(b.conflictsWithId !== null) - Number(a.conflictsWithId !== null) ||
        b.salience - a.salience ||
        a.recordedAt.localeCompare(b.recordedAt),
    )
    .slice(0, opts.cap);
}

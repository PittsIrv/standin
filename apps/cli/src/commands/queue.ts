import { reviewQueue, type ReviewItem } from "@standin/compaction";
import type { Store } from "@standin/store";
import { formatSources, table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { flag, json, type Command } from "./shared.ts";

function describe(store: Store, item: ReviewItem): string {
  const m = item.memory;
  if (item.kind === "still-true") return `still true? "${m.statement}" (last mentioned ${m.lastCorroboratedAt.slice(0, 10)})`;
  if (m.conflictsWithId) return `${m.statement}  ⚡ conflicts with ${m.conflictsWithId}: "${store.getMemory(m.conflictsWithId).statement}"`;
  if (m.supersedesId) return `${m.statement}  ↻ replaces ${m.supersedesId}: "${store.getMemory(m.supersedesId).statement}"`;
  // Lighting proposals from the knowledge map carry their reasons.
  if (m.kind === "competence" && m.attrs.reasons?.length) return `${m.statement}  — why: ${m.attrs.reasons.join("; ")}`;
  return m.statement;
}

export const queueCommand: Command = {
  options: { ...json },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const items = reviewQueue(store, config);
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(items, null, 2));
        return 0;
      }
      if (items.length === 0) {
        ctx.io.stdout("Nothing to review.");
        return 0;
      }
      const rows = items.map((i) => [i.memory.id, i.group, i.memory.kind, String(i.memory.tier), formatSources(i.sources), describe(store, i)]);
      ctx.io.stdout(table(["id", "group", "kind", "tier", "sources", "statement"], rows));
      ctx.io.stdout(`\n${items.length} to review. Approve with: standin approve <id> [--tier T] · still-true: standin keep|expire <id>`);
      return 0;
    } finally {
      store.close();
    }
  },
};

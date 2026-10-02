import { reviewQueue } from "@standin/compaction";
import type { Memory } from "@standin/schema";
import { MEMORY_HEADERS, memoryRows, table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { flag, json, type Command } from "./shared.ts";

export const queueCommand: Command = {
  options: { ...json },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const queue = reviewQueue(store, { cap: config.review.weeklyCap });
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(queue, null, 2));
        return 0;
      }
      if (queue.length === 0) {
        ctx.io.stdout("Nothing to review.");
        return 0;
      }
      const note = (m: Memory) => {
        if (m.conflictsWithId) return `  ⚡ conflicts with ${m.conflictsWithId}: "${store.getMemory(m.conflictsWithId).statement}"`;
        if (m.supersedesId) return `  ↻ replaces ${m.supersedesId}: "${store.getMemory(m.supersedesId).statement}"`;
        return "";
      };
      const total = store.listMemories({ status: "proposed" }).length;
      ctx.io.stdout(table(MEMORY_HEADERS, memoryRows(queue, note)));
      ctx.io.stdout(`\n${queue.length} of ${total} proposed (weekly cap ${config.review.weeklyCap}). Approve with: standin approve <id> [--tier T]`);
      return 0;
    } finally {
      store.close();
    }
  },
};

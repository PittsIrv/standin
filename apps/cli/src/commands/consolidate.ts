import { loadInstance } from "../home.ts";
import { flag, json, type Command } from "./shared.ts";

export const consolidateCommand: Command = {
  options: { ...json },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const report = store.consolidate(config);
      if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify(report, null, 2));
      else
        ctx.io.stdout(
          `expired ${report.expired.length}, re-scored ${report.recomputed}, purged raw text of ${report.purged} observations`,
        );
      return 0;
    } finally {
      store.close();
    }
  },
};

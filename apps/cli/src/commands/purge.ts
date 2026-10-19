import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { flag, json, str, type Command } from "./shared.ts";

export const purgeCommand: Command = {
  options: { before: { type: "string" }, ...json },
  async run(ctx) {
    const raw = str(ctx, "before");
    if (raw === undefined) throw new CliError("usage: standin purge --before <ISO date>");
    const before = new Date(raw);
    if (Number.isNaN(before.getTime())) throw new CliError(`--before is not a date: ${raw}`);
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const result = store.purge(before.toISOString());
      if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify(result, null, 2));
      else ctx.io.stdout(`purged raw text of ${result.observations} observations and the trace text of ${result.spanContent} spans`);
      return 0;
    } finally {
      store.close();
    }
  },
};

import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd } from "../runtime.ts";
import { flag, json, str, type Command } from "./shared.ts";

/** Share of input tokens read from the prompt cache (input tokens include cached ones). */
const cachedShare = (cacheRead: number, input: number) => (input === 0 ? "-" : `${Math.round((100 * cacheRead) / input)}%`);

export const usageCommand: Command = {
  options: { since: { type: "string" }, by: { type: "string" }, ...json },
  async run(ctx) {
    const by = str(ctx, "by") ?? "role";
    if (by !== "role" && by !== "model") throw new CliError(`--by must be role or model, got "${by}"`);
    const since = str(ctx, "since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new CliError(`--since is not a date: ${since}`);
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const rows = store.usage({ by, since: since === undefined ? undefined : new Date(since).toISOString() });
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (rows.length === 0) {
        ctx.io.stdout("No model calls recorded yet.");
        return 0;
      }
      ctx.io.stdout(
        table(
          [by, "calls", "failed", "in", "out", "cached", "cost", "unpriced"],
          rows.map((r) =>
            [r.key, r.calls, r.failed, r.inputTokens, r.outputTokens, cachedShare(r.cacheReadTokens, r.inputTokens), fmtUsd(r.costUsd), r.unpricedCalls].map(String),
          ),
        ),
      );
      const total = rows.reduce((t, r) => ({ calls: t.calls + r.calls, cost: t.cost + r.costUsd, unpriced: t.unpriced + r.unpricedCalls }), {
        calls: 0,
        cost: 0,
        unpriced: 0,
      });
      ctx.io.stdout(`total: ${total.calls} calls, ${fmtUsd(total.cost)}`);
      if (total.unpriced > 0) ctx.io.stdout(`${total.unpriced} calls have no known price (add one under models.prices in config.json)`);
      return 0;
    } finally {
      store.close();
    }
  },
};

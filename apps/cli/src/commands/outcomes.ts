import { readFileSync, writeFileSync } from "node:fs";
import { clearPriors, outcomeRecords, setPriors } from "@standin/knowledge";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { flag, str, type Command } from "./shared.ts";

/**
 * `standin outcomes export [--out F]` and `standin outcomes priors <file> | --clear` (questions spec §3). Export needs
 * the person's consent in the config, and only ever writes a local file.
 */
export const outcomesCommand: Command = {
  options: { out: { type: "string" }, clear: { type: "boolean" } },
  async run(ctx) {
    const sub = ctx.positionals[0];
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (sub === "export") {
        if (!config.sharing.outcomes)
          throw new CliError('Sharing outcomes is off. To allow it, add "sharing": { "outcomes": true } to your config.json, then run this again. Nothing is ever sent; it writes a local file.');
        const records = outcomeRecords(store);
        const out = str(ctx, "out") ?? "standin-outcomes.json";
        writeFileSync(out, `${JSON.stringify({ records }, null, 2)}\n`, { mode: 0o600 });
        ctx.io.stdout(`Wrote ${records.length} records to ${out}: evidence kind, raw score, hops, depths and outcome only; no names, topics or times.`);
        return 0;
      }
      if (sub === "priors") {
        if (flag(ctx, "clear")) {
          clearPriors(store);
          ctx.io.stdout("Default reliabilities cleared.");
          return 0;
        }
        const file = ctx.positionals[1];
        if (!file) throw new CliError("usage: standin outcomes priors <file> | --clear");
        let cells;
        try {
          cells = setPriors(store, JSON.parse(readFileSync(file, "utf8")), config.hypotheses.priorCap);
        } catch (err) {
          throw new CliError(`${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (const [key, c] of Object.entries(cells)) ctx.io.stdout(`${key}  a ${+c.a.toFixed(2)}  b ${+c.b.toFixed(2)}`);
        ctx.io.stdout(`Loaded ${Object.keys(cells).length} cells, each capped at ${config.hypotheses.priorCap} pseudo-counts.`);
        return 0;
      }
      throw new CliError("usage: standin outcomes export [--out F] | standin outcomes priors <file> | --clear");
    } finally {
      store.close();
    }
  },
};

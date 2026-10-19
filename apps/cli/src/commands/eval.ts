import { evalDedup, KS, loadDedupCases, METHODS } from "@standin/compaction";
import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { flag, json, type Command } from "./shared.ts";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export const evalCommand: Command = {
  options: { ...json },
  async run(ctx) {
    if (ctx.positionals[0] !== "dedup") throw new CliError("usage: standin eval dedup [--json]");
    const cases = loadDedupCases();
    const reports = evalDedup(cases);
    if (flag(ctx, "json")) {
      ctx.io.stdout(JSON.stringify(reports, null, 2));
      return 0;
    }
    const rows = reports.map((r) => [r.method, ...KS.map((k) => pct(r.recall[k])), r.avgCandidates.toFixed(1), r.misses.join(", ") || "-"]);
    ctx.io.stdout(table(["method", ...KS.map((k) => `recall@${k}`), "sent", "missed at 8"], rows));
    ctx.io.stdout(
      `\n${cases.length} labeled cases. "sent" is the average number of memories passed to reconcile.\n` +
        METHODS.map((m) => `  ${m.name}: ${m.describe}`).join("\n"),
    );
    return 0;
  },
};

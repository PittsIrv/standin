import { cardScores, loadSnapshot, refresh, renderForest, treeNodes } from "@standin/knowledge";
import type { Store } from "@standin/store";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd, instanceModels, instanceTracer } from "../runtime.ts";
import { flag, json, type Command, type CommandContext } from "./shared.ts";

/** Predict, then learn: how often the standin's prediction matched what you then said; the guess score only privately. */
function scoreLines(store: Store, showPrivate: boolean, brierWindow: number): string[] {
  const { map, guesses: g } = cardScores(store, brierWindow);
  const lines = [map.n === 0 ? "Map score: no answers yet" : `Map score: ${map.agree}/${map.n} (${Math.round(map.score! * 100)}%) of your answers matched the standin's prediction`];
  if (!showPrivate) return lines;
  lines.push(
    g.n === 0
      ? "Hypothesis calibration: not enough answers about guesses yet"
      : `Hypothesis calibration: Brier ${g.calibrated!.toFixed(2)} (calibrated) vs ${g.prior!.toFixed(2)} (prior) over ${g.n} answer${g.n === 1 ? "" : "s"}${g.tripped ? "; using prior-only probabilities" : ""}`,
  );
  return lines;
}

async function show(ctx: CommandContext): Promise<number> {
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const t = loadSnapshot(store, { brierWindow: config.hypotheses.brierWindow });
    if (flag(ctx, "json")) {
      const c = cardScores(store, config.hypotheses.brierWindow);
      ctx.io.stdout(JSON.stringify({ nodes: treeNodes(t, { all: flag(ctx, "all") }), scores: flag(ctx, "private") ? c : { map: c.map } }, null, 2));
    } else ctx.io.stdout([renderForest(t, { all: flag(ctx, "all") }), "", ...scoreLines(store, flag(ctx, "private"), config.hypotheses.brierWindow)].join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

async function refreshTree(ctx: CommandContext): Promise<number> {
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const tracer = instanceTracer(ctx, store, config);
    const models = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") });
    const report = await refresh({
      store,
      map: models.for("map"),
      hypothesize: models.for("hypothesize"),
      hypotheses: config.hypotheses,
      tracer,
      personaName: config.persona.name,
      splitAt: config.tree.splitAt,
    });
    if (flag(ctx, "json")) {
      ctx.io.stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    const run = store.listRuns({ kind: "map-refresh", limit: 1 })[0];
    const lines = [
      report.seeded.length > 0 ? `seeded ${report.seeded.join(", ")}` : "no new background to seed",
      `placed ${report.placed} node${report.placed === 1 ? "" : "s"}, merged ${report.merged}${report.refused.length > 0 ? `, refused (would make a cycle): ${report.refused.join(", ")}` : ""}`,
      `homed ${report.homed} memor${report.homed === 1 ? "y" : "ies"}${report.split.length > 0 ? `, split ${report.split.join(", ")}` : ""}`,
      `recorded ${report.gaps} stated gap${report.gaps === 1 ? "" : "s"}`,
      `hypotheses: +${report.hypotheses.added}, withdrawn ${report.hypotheses.withdrawn}, rejected ${report.hypotheses.rejected.length}`,
      ...report.hypotheses.rejected.map((r) => `  rejected ${r}`),
      ...report.warnings.map((w) => `warning: ${w}`),
    ];
    if (run) lines.push(`cost ${fmtUsd(run.costUsd)}${run.unpricedCalls > 0 ? ` (+${run.unpricedCalls} unpriced calls)` : ""}`);
    lines.push("Next: standin queue");
    ctx.io.stdout(lines.join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

export const mapCommand: Command = {
  options: { "demo-llm": { type: "boolean" }, private: { type: "boolean" }, all: { type: "boolean" }, ...json },
  async run(ctx) {
    const sub = ctx.positionals[0];
    if (sub === undefined) return show(ctx);
    if (sub === "refresh") return refreshTree(ctx);
    throw new CliError("usage: standin map [--json] [--private] [--all] | map refresh [--demo-llm]");
  },
};

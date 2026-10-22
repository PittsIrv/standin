import { calibration, loadSnapshot, refresh, renderForest, safeguard, treeNodes, type SetScore, type TreeSnapshot } from "@standin/knowledge";
import type { Store } from "@standin/store";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd, instanceModels, instanceTracer } from "../runtime.ts";
import { flag, json, type Command, type CommandContext } from "./shared.ts";

const fmtSet = (s: SetScore) => `${s.agree}/${s.n}${s.score === null ? "" : ` (${Math.round(s.score * 100)}%)`}`;

/** The map score always; the presented score only on request, since it shows how far you present beyond your ratings. */
function calibrationLines(store: Store, t: TreeSnapshot, showPrivate: boolean, brierWindow: number): string[] {
  const c = calibration(store, t);
  const lines =
    c.presented.fixed.n + c.presented.rotating.n === 0
      ? ["Calibration: not enough held-out answers yet"]
      : [`Calibration (map score): fixed ${fmtSet(c.map.fixed)}, rotating ${fmtSet(c.map.rotating)}`];
  if (!showPrivate) return lines;
  if (c.presented.fixed.n + c.presented.rotating.n > 0)
    lines.push(`Presented score (private): fixed ${fmtSet(c.presented.fixed)}, rotating ${fmtSet(c.presented.rotating)}`);
  // Is learning from outcomes helping? Calibrated guesses against prior-only ones, on held-out answers.
  const g = safeguard(store, brierWindow);
  lines.push(
    g.n === 0
      ? "Hypothesis calibration: not enough held-out hypothesis answers yet"
      : `Hypothesis calibration: Brier ${g.calibrated!.toFixed(2)} (calibrated) vs ${g.prior!.toFixed(2)} (prior) over ${g.n} held-out answer${g.n === 1 ? "" : "s"}${g.tripped ? "; using prior-only probabilities" : ""}`,
  );
  return lines;
}

async function show(ctx: CommandContext): Promise<number> {
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const t = loadSnapshot(store, { brierWindow: config.hypotheses.brierWindow });
    if (flag(ctx, "json")) {
      const c = calibration(store, t);
      ctx.io.stdout(JSON.stringify({ nodes: treeNodes(t, { all: flag(ctx, "all") }), calibration: flag(ctx, "private") ? c : { map: c.map } }, null, 2));
    } else ctx.io.stdout([renderForest(t, { all: flag(ctx, "all") }), "", ...calibrationLines(store, t, flag(ctx, "private"), config.hypotheses.brierWindow)].join("\n"));
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

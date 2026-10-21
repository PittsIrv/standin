import { calibration, loadSnapshot, refresh, renderForest, treeNodes, type SetScore, type TreeSnapshot } from "@standin/knowledge";
import type { Store } from "@standin/store";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd, instanceModels, instanceTracer } from "../runtime.ts";
import { flag, json, type Command, type CommandContext } from "./shared.ts";

const fmtSet = (s: SetScore) => `${s.agree}/${s.n}${s.score === null ? "" : ` (${Math.round(s.score * 100)}%)`}`;

/** The map score always; the presented score only on request, since it shows how far you present beyond your ratings. */
function calibrationLines(store: Store, t: TreeSnapshot, showPrivate: boolean): string[] {
  const c = calibration(store, t);
  if (c.presented.fixed.n + c.presented.rotating.n === 0) return ["Calibration: not enough held-out answers yet"];
  const lines = [`Calibration (map score): fixed ${fmtSet(c.map.fixed)}, rotating ${fmtSet(c.map.rotating)}`];
  if (showPrivate) lines.push(`Presented score (private): fixed ${fmtSet(c.presented.fixed)}, rotating ${fmtSet(c.presented.rotating)}`);
  return lines;
}

async function show(ctx: CommandContext): Promise<number> {
  const { store } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const t = loadSnapshot(store);
    if (flag(ctx, "json")) {
      const c = calibration(store, t);
      ctx.io.stdout(JSON.stringify({ nodes: treeNodes(t, { all: flag(ctx, "all") }), calibration: flag(ctx, "private") ? c : { map: c.map } }, null, 2));
    } else ctx.io.stdout([renderForest(t, { all: flag(ctx, "all") }), "", ...calibrationLines(store, t, flag(ctx, "private"))].join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

async function refreshTree(ctx: CommandContext): Promise<number> {
  const { store, config } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const tracer = instanceTracer(ctx, store, config);
    const map = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") }).for("map");
    const report = await refresh({ store, map, tracer, personaName: config.persona.name, splitAt: config.tree.splitAt });
    if (flag(ctx, "json")) {
      ctx.io.stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    const run = store.listRuns({ kind: "map-refresh", limit: 1 })[0];
    const lines = [
      report.seeded.length > 0 ? `seeded ${report.seeded.join(", ")}` : "no new background to seed",
      `placed ${report.placed} topic${report.placed === 1 ? "" : "s"}, merged ${report.merged}${report.refused.length > 0 ? `, refused (would make a cycle): ${report.refused.join(", ")}` : ""}`,
      `homed ${report.homed} memor${report.homed === 1 ? "y" : "ies"}${report.split.length > 0 ? `, split ${report.split.join(", ")}` : ""}`,
      `recorded ${report.gaps} stated gap${report.gaps === 1 ? "" : "s"}`,
      `proposed ${report.proposed} lighting change${report.proposed === 1 ? "" : "s"}${report.replaced > 0 ? ` (replacing ${report.replaced})` : ""}`,
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

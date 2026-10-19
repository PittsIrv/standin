import { answerMode, loadSnapshot, refresh, type TreeSnapshot } from "@standin/knowledge";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { fmtUsd, instanceModels, instanceTracer } from "../runtime.ts";
import { flag, json, type Command, type CommandContext } from "./shared.ts";

interface NodeView {
  id: string;
  name: string;
  parent: string | null;
  mode: string;
  depth: number | null;
  basis: string | null;
  via: "own" | "inherited" | "gap" | null;
  from: string | null;
  boundary: boolean;
}

function views(t: TreeSnapshot): NodeView[] {
  const name = (id: string) => t.topics.get(id)?.name ?? id;
  return [...t.topics.values()].map((topic) => {
    const d = answerMode(t, topic.id);
    const parent = t.parentOf.get(topic.id);
    return {
      id: topic.id,
      name: topic.name,
      parent: parent ? name(parent) : null,
      mode: d.mode,
      depth: d.depth,
      basis: d.from ? (d.from.via === "gap" ? "gap" : (t.approved.get(d.from.nodeId)?.basis ?? null)) : null,
      via: d.from?.via ?? null,
      from: d.from ? name(d.from.nodeId) : null,
      boundary: d.boundary,
    };
  });
}

function status(v: NodeView): string {
  const lit =
    v.depth === null
      ? "dark"
      : v.via === "gap"
        ? `gap: fine up to ${v.depth}`
        : v.via === "inherited"
          ? `lit ${v.depth} (inherited from ${v.from})`
          : `lit ${v.depth} (${v.basis})`;
  return v.boundary ? `${lit} · boundary` : lit;
}

/** The tree, indented under each root; topics with no place yet are listed last. */
function render(t: TreeSnapshot): string {
  const all = views(t);
  const byName = new Map(all.map((v) => [v.id, v]));
  const children = new Map<string, NodeView[]>();
  for (const [child, parent] of t.parentOf) children.set(parent, [...(children.get(parent) ?? []), byName.get(child)!]);
  const placed = (v: NodeView) => t.parentOf.has(v.id) || children.has(v.id);
  const lines: string[] = [];
  const walk = (v: NodeView, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${v.name}  ${status(v)}`);
    for (const c of (children.get(v.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))) walk(c, depth + 1);
  };
  for (const root of all.filter((v) => placed(v) && !t.parentOf.has(v.id)).sort((a, b) => a.name.localeCompare(b.name))) walk(root, 0);
  const loose = all.filter((v) => !placed(v));
  if (loose.length > 0) lines.push("", "Not yet placed (run `standin map refresh`):", ...loose.map((v) => `  ${v.name}  ${status(v)}`));
  return lines.length > 0 ? lines.join("\n") : "Your knowledge tree is empty. Approve some memories, then run `standin map refresh`.";
}

async function show(ctx: CommandContext): Promise<number> {
  const { store } = loadInstance(ctx.home, ctx.io.clock);
  try {
    const t = loadSnapshot(store);
    if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify({ nodes: views(t) }, null, 2));
    else ctx.io.stdout(render(t));
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
    const report = await refresh({ store, map, tracer, personaName: config.persona.name });
    if (flag(ctx, "json")) {
      ctx.io.stdout(JSON.stringify(report, null, 2));
      return 0;
    }
    const run = store.listRuns({ kind: "map-refresh", limit: 1 })[0];
    const lines = [
      report.seeded.length > 0 ? `seeded ${report.seeded.join(", ")}` : "no new background to seed",
      `placed ${report.placed} topic${report.placed === 1 ? "" : "s"}, merged ${report.merged}${report.refused.length > 0 ? `, refused (would make a cycle): ${report.refused.join(", ")}` : ""}`,
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
  options: { "demo-llm": { type: "boolean" }, ...json },
  async run(ctx) {
    const sub = ctx.positionals[0];
    if (sub === undefined) return show(ctx);
    if (sub === "refresh") return refreshTree(ctx);
    throw new CliError("usage: standin map [--json] | map refresh [--demo-llm]");
  },
};

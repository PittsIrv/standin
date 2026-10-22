import { answerTurn, type Reply } from "@standin/speak";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { fmtMs, fmtUsd, instanceModels, instanceTracer, instanceTurn } from "../runtime.ts";
import { flag, json, type Command } from "./shared.ts";

/** "[grounded]", "[not on record: competence]", … */
export const stateLabel = (r: Pick<Reply, "state" | "reason">) => `[${r.state.replace(/_/g, " ")}${r.reason ? `: ${r.reason}` : ""}]`;

/** The show-your-work record as lines (architecture §8). */
export function workLines(r: Reply): string[] {
  const w = r.work;
  const model = w.checks.model === null ? "not run" : typeof w.checks.model === "string" ? w.checks.model : w.checks.model.supported ? "supported" : `unsupported: ${w.checks.model.unsupported.join("; ")}`;
  return [
    `Candidates: ${w.candidates.join(", ") || "none"}`,
    `Seeds: ${w.seeds.map((s) => `${s.name} (${s.root ?? "unplaced"}${s.mode ? `, ${s.mode}` : ""}${s.boundary ? ", boundary" : ""})`).join(", ") || "none"}`,
    "Context:",
    ...(w.context.length ? w.context.map((c) => `  [${c.id}] (${c.kind}, ${c.node}) ${c.text}`) : ["  (nothing)"]),
    `Filtered: ${w.filtered.map((f) => `${f.id} ${f.reason}`).join(", ") || "nothing"}`,
    `Style examples: ${w.exemplars}`,
    `Checks: code ${w.checks.code ?? "ok"}; model ${model}`,
    ...(w.rejected ? [`Stopped reply: ${w.rejected}`] : []),
    `${w.modelCalls} model call${w.modelCalls === 1 ? "" : "s"}, ${fmtUsd(w.costUsd)}, ${fmtMs(w.ms)}, trace ${r.traceId.slice(0, 12)}`,
  ];
}

/** `standin ask "<question>"`: one question, answered as a visitor would be (answering spec §4). */
export const askCommand: Command = {
  options: { work: { type: "boolean" }, "demo-llm": { type: "boolean" }, ...json },
  async run(ctx) {
    const question = ctx.positionals.join(" ").trim();
    if (!question) throw new CliError('usage: standin ask "<question>" [--work] [--json]');
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const tracer = instanceTracer(ctx, store, config);
      const models = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") });
      const r = await answerTurn(instanceTurn(store, config, tracer, models), question);
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(r, null, 2));
        return 0;
      }
      const lines = [r.text, "", stateLabel(r), ...r.cites.map((c) => `  - ${c.statement} (${c.node})`)];
      if (flag(ctx, "work")) lines.push("", ...workLines(r));
      ctx.io.stdout(lines.join("\n"));
      return 0;
    } finally {
      store.close();
    }
  },
};

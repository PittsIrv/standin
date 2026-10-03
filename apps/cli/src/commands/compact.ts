import { abandonBatch, compact, compactBatch, type BatchStep, type CompactionReport } from "@standin/compaction";
import { demoLLM } from "@standin/demo-persona";
import { createLLM, supportsBatch, type LLM } from "@standin/llm";
import type { Config } from "@standin/schema";
import type { Store } from "@standin/store";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { flag, json, str, type Command, type CommandContext } from "./shared.ts";

const POLL_MS = 30_000;

function models(ctx: CommandContext, config: Config): { llm: LLM; reconcileLLM: LLM; label: string } {
  if (flag(ctx, "demo-llm")) {
    const llm = demoLLM();
    return { llm, reconcileLLM: llm, label: "demo" };
  }
  const extract = config.compaction.model;
  const reconcile = config.compaction.reconcileModel;
  const llm = createLLM(extract, ctx.io.env);
  return { llm, reconcileLLM: reconcile ? createLLM(reconcile, ctx.io.env) : llm, label: extract.model };
}

function parseLimit(ctx: CommandContext): number | undefined {
  const raw = str(ctx, "limit");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new CliError(`--limit must be a positive integer, got "${raw}"`);
  return n;
}

function reportLines(report: CompactionReport): string[] {
  return [
    `processed ${report.processed}, skipped (exposed) ${report.skippedExposed}, failed ${report.failed.length}`,
    `new ${report.created}, corroborated ${report.corroborated}, updates ${report.updates}, contradictions ${report.contradictions}`,
    `dropped (previously rejected) ${report.droppedAsRejected}, invalid candidates ${report.invalidCandidates}, exemplars ${report.exemplars}`,
    ...report.failed.map((f) => `  failed ${f.observationId}: ${f.error}`),
    report.failed.length > 0 ? "Retry failures with: standin compact --retry-failed" : "Next: standin queue",
  ];
}

function stepLines(step: BatchStep, wait: boolean): string[] {
  switch (step.kind) {
    case "idle":
      return ["Nothing to compact."];
    case "submitted":
      return [
        `Submitted batch ${step.batchId}: ${step.observations} observations (skipped exposed: ${step.skippedExposed}).`,
        ...(wait ? [] : ["Results usually arrive within an hour. Collect them with: standin compact --batch"]),
      ];
    case "processing":
      return [`Batch ${step.batchId} is still processing (${step.status.succeeded + step.status.errored} done, ${step.status.processing} left).`];
    case "collected":
      return [`Collected batch ${step.batchId}.`, ...reportLines(step.report)];
  }
}

async function runBatch(ctx: CommandContext, store: Store, config: Config, llm: LLM, reconcileLLM: LLM, label: string) {
  if (!supportsBatch(llm)) throw new CliError("--batch needs a provider with a batch API (the anthropic provider)");
  const wait = flag(ctx, "wait");
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const opts = { store, llm, reconcileLLM, config, modelLabel: label, limit: parseLimit(ctx), retryFailed: flag(ctx, "retry-failed") };

  let step = await compactBatch(opts);
  while (wait && (step.kind === "submitted" || step.kind === "processing")) {
    if (!flag(ctx, "json")) ctx.io.stdout(stepLines(step, wait).join("\n"));
    await sleep(POLL_MS);
    step = await compactBatch(opts);
  }
  if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify(step, null, 2));
  else ctx.io.stdout(stepLines(step, wait).join("\n"));
  return step.kind === "collected" && step.report.failed.length > 0 ? 1 : 0;
}

export const compactCommand: Command = {
  options: {
    limit: { type: "string" },
    "retry-failed": { type: "boolean" },
    "demo-llm": { type: "boolean" },
    batch: { type: "boolean" },
    wait: { type: "boolean" },
    "abandon-batch": { type: "boolean" },
    ...json,
  },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      if (flag(ctx, "abandon-batch")) {
        const id = abandonBatch(store);
        ctx.io.stdout(id ? `Abandoned batch ${id}; its observations are pending again.` : "No open batch.");
        return 0;
      }
      const { llm, reconcileLLM, label } = models(ctx, config);
      if (flag(ctx, "batch")) return await runBatch(ctx, store, config, llm, reconcileLLM, label);

      const open = store.openCompactionBatch();
      if (open && !flag(ctx, "json")) {
        ctx.io.stderr(`note: batch ${open.providerBatchId} is open; its ${open.observationIds.length} observations wait for: standin compact --batch`);
      }
      const report = await compact({ store, llm, reconcileLLM, config, limit: parseLimit(ctx), retryFailed: flag(ctx, "retry-failed") });
      if (flag(ctx, "json")) ctx.io.stdout(JSON.stringify(report, null, 2));
      else ctx.io.stdout(reportLines(report).join("\n"));
      return report.failed.length > 0 ? 1 : 0;
    } finally {
      store.close();
    }
  },
};

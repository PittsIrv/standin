import { compact } from "@standin/compaction";
import { demoLLM } from "@standin/demo-persona";
import { AnthropicLLM } from "@standin/llm";
import { loadInstance } from "../home.ts";
import { flag, json, str, type Command } from "./shared.ts";

export const compactCommand: Command = {
  options: { limit: { type: "string" }, "retry-failed": { type: "boolean" }, "demo-llm": { type: "boolean" }, ...json },
  async run(ctx) {
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const llm = flag(ctx, "demo-llm") ? demoLLM() : new AnthropicLLM({ model: config.compaction.model });
      const limit = str(ctx, "limit");
      const report = await compact({
        store,
        llm,
        config,
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        retryFailed: flag(ctx, "retry-failed"),
      });
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(report, null, 2));
      } else {
        ctx.io.stdout(
          [
            `processed ${report.processed}, skipped (exposed) ${report.skippedExposed}, failed ${report.failed.length}`,
            `new ${report.created}, corroborated ${report.corroborated}, updates ${report.updates}, contradictions ${report.contradictions}`,
            `dropped (previously rejected) ${report.droppedAsRejected}, invalid candidates ${report.invalidCandidates}, exemplars ${report.exemplars}`,
            ...report.failed.map((f) => `  failed ${f.observationId}: ${f.error}`),
            report.failed.length > 0 ? "Retry failures with: standin compact --retry-failed" : "Next: standin queue",
          ].join("\n"),
        );
      }
      return report.failed.length > 0 ? 1 : 0;
    } finally {
      store.close();
    }
  },
};

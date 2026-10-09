import { CliError } from "../errors.ts";
import { table } from "../format.ts";
import { loadInstance } from "../home.ts";
import { fmtMs, fmtUsd, renderTraceTree } from "../runtime.ts";
import { flag, json, str, type Command } from "./shared.ts";

export const tracesCommand: Command = {
  options: { since: { type: "string" }, kind: { type: "string" }, limit: { type: "string" }, ...json },
  async run(ctx) {
    const since = str(ctx, "since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new CliError(`--since is not a date: ${since}`);
    const limitArg = str(ctx, "limit");
    const limit = limitArg === undefined ? 20 : Number(limitArg);
    if (!Number.isInteger(limit) || limit <= 0) throw new CliError(`--limit must be a positive integer, got "${limitArg}"`);
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const runs = store.listRuns({ since: since === undefined ? undefined : new Date(since).toISOString(), kind: str(ctx, "kind"), limit });
      if (flag(ctx, "json")) {
        ctx.io.stdout(JSON.stringify(runs, null, 2));
        return 0;
      }
      if (runs.length === 0) {
        ctx.io.stdout("No runs recorded yet.");
        return 0;
      }
      ctx.io.stdout(
        table(
          ["trace", "kind", "started", "took", "calls", "cost", "status"],
          runs.map((r) => [
            r.traceId.slice(0, 12),
            r.kind,
            r.startTime.slice(0, 19).replace("T", " "),
            fmtMs(r.durationMs),
            String(r.modelCalls),
            fmtUsd(r.costUsd) + (r.unpricedCalls > 0 ? ` (+${r.unpricedCalls} unpriced)` : ""),
            r.status === "error" ? "error" : "ok",
          ]),
        ),
      );
      ctx.io.stdout("Show one with: standin trace <trace>");
      return 0;
    } finally {
      store.close();
    }
  },
};

export const traceCommand: Command = {
  options: { last: { type: "boolean" }, content: { type: "boolean" }, ...json },
  async run(ctx) {
    const { store } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const id = flag(ctx, "last") ? store.lastTraceId() : ctx.positionals[0];
      if (!id) throw new CliError(flag(ctx, "last") ? "no runs recorded yet" : "usage: standin trace <trace id or prefix> | --last");
      let spans;
      try {
        spans = store.getTrace(id);
      } catch (err) {
        // Prefix-length errors are plain Errors; surface them as CLI errors.
        if (err instanceof Error && err.name === "Error") throw new CliError(err.message);
        throw err;
      }
      ctx.io.stdout(flag(ctx, "json") ? JSON.stringify(spans, null, 2) : renderTraceTree(spans, { content: flag(ctx, "content") }));
      return 0;
    } finally {
      store.close();
    }
  },
};

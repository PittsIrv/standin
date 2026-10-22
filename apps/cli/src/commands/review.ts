import { networkInterfaces } from "node:os";
import { reviewQueue } from "@standin/compaction";
import { CardSession } from "@standin/knowledge";
import { startReviewServer } from "@standin/review";
import { renderUnicodeCompact } from "uqr";
import { CliError } from "../errors.ts";
import { loadInstance } from "../home.ts";
import { instanceModels, instanceTracer } from "../runtime.ts";
import { flag, str, type Command } from "./shared.ts";

/** The first non-internal IPv4 address: where a phone on the same network can reach this machine. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  throw new CliError("no local network address found");
}

function positiveInt(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (name === "--port" ? 0 : 1)) throw new CliError(`${name} must be a ${name === "--port" ? "port number" : "positive integer"}`);
  return n;
}

/** `standin review`: a probing session in a local page, saved as you go. Ctrl-C stops it; the next one resumes. */
export const reviewCommand: Command = {
  options: { port: { type: "string" }, lan: { type: "boolean" }, "demo-llm": { type: "boolean" } },
  async run(ctx) {
    const port = positiveInt(str(ctx, "port"), "--port");
    const lan = flag(ctx, "lan");
    const publicHost = lan ? lanAddress() : null;
    const { store, config } = loadInstance(ctx.home, ctx.io.clock);
    try {
      const tracer = instanceTracer(ctx, store, config);
      const models = instanceModels(ctx, config, tracer, { demo: flag(ctx, "demo-llm") });
      ctx.io.stdout("Starting a review session (this refreshes your tree)…");
      const session = await CardSession.start({
        store,
        map: models.for("map"),
        hypothesize: models.for("hypothesize"),
        tracer,
        personaName: config.persona.name,
        splitAt: config.tree.splitAt,
        hypotheses: config.hypotheses,
      });
      for (const w of session.warnings.splice(0)) ctx.io.stdout(`warning: ${w}`);
      const server = await startReviewServer({ session, store, config, host: lan ? "0.0.0.0" : "127.0.0.1", port, speakAt: config.hypotheses.speakAt });
      const url = publicHost ? server.url.replace("//0.0.0.0:", `//${publicHost}:`) : server.url;
      ctx.io.stdout(`Review page: ${url}`);
      if (publicHost) {
        ctx.io.stdout(renderUnicodeCompact(url));
        ctx.io.stdout("Anyone on your network with this link can see your private data.");
      }
      ctx.io.stdout("Your answers are saved as you go. Press Ctrl-C to stop; the next review picks up where you left off.");
      const onInterrupt = ctx.io.onInterrupt ?? ((h: () => void) => (process.once("SIGINT", h), () => process.off("SIGINT", h)));
      const stop = onInterrupt(() => void server.finish());
      const report = await server.closed;
      stop();
      ctx.io.stdout(`Stopped: answered ${report.answered} card${report.answered === 1 ? "" : "s"}, settled ${report.settled} guess${report.settled === 1 ? "" : "es"}. The next review picks up where you left off.`);
      if (reviewQueue(store, config).length > 0) ctx.io.stdout("Next: standin queue");
      return 0;
    } finally {
      store.close();
    }
  },
};

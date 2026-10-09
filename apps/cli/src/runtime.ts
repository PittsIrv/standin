import { demoLLM } from "@standin/demo-persona";
import { createModels, type Models } from "@standin/models";
import type { Config } from "@standin/schema";
import type { Store } from "@standin/store";
import { OtlpHttpSink, Tracer, type SpanContent, type SpanData, type SpanSink } from "@standin/trace";
import type { CommandContext } from "./commands/shared.ts";

/** "k=v,k2=v2" → headers. Values may contain "=". */
function parseHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

/** Spans go to the instance store, and to an OTLP collector when one is configured. Sink failures are warnings. */
export function instanceTracer(ctx: CommandContext, store: Store, config: Config): Tracer {
  const sinks: SpanSink[] = [store.spanSink()];
  const otlp = config.tracing.otlp;
  if (otlp) {
    sinks.push(
      new OtlpHttpSink({
        endpoint: otlp.endpoint,
        headers: parseHeaders(otlp.headersEnv ? ctx.io.env[otlp.headersEnv] : undefined),
        includeContent: otlp.exportContent,
      }),
    );
  }
  return new Tracer({
    sinks,
    clock: ctx.io.clock,
    onSinkError: (err) => ctx.io.stderr(`warning: trace export failed: ${err instanceof Error ? err.message : String(err)}`),
  });
}

/** The role router for this instance; `demo` answers every role with the offline demo persona. */
export function instanceModels(ctx: CommandContext, config: Config, tracer: Tracer, opts: { demo: boolean }): Models {
  const demo = opts.demo ? demoLLM() : null;
  return createModels({ config, env: ctx.io.env, tracer, ...(demo ? { providerFor: () => demo } : {}) });
}

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtUsd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

/** One line per span, indented by depth (spans arrive in depth-first order). */
export function renderTraceTree(spans: { span: SpanData; content: SpanContent | null }[], opts: { content?: boolean } = {}): string {
  const depth = new Map<string, number>();
  const lines: string[] = [];
  for (const { span, content } of spans) {
    const d = span.parentSpanId !== null && depth.has(span.parentSpanId) ? depth.get(span.parentSpanId)! + 1 : 0;
    depth.set(span.spanId, d);
    const a = span.attributes;
    const parts = [`${"  ".repeat(d)}${span.name}`, fmtMs(Date.parse(span.endTime) - Date.parse(span.startTime))];
    if (a["standin.run.kind"] !== undefined) parts.push(String(a["standin.run.kind"]));
    if (a["standin.role"] !== undefined) parts.push(`role=${a["standin.role"]}`);
    if (a["gen_ai.usage.input_tokens"] !== undefined) parts.push(`in=${a["gen_ai.usage.input_tokens"]} out=${a["gen_ai.usage.output_tokens"] ?? 0}`);
    if (typeof a["standin.cost_usd"] === "number") parts.push(fmtUsd(a["standin.cost_usd"]));
    if (a["standin.batch"] === true) parts.push("batch");
    if (span.status.code === "error") parts.push(`✗ ${span.status.message ?? "error"}`);
    lines.push(parts.join("  "));
    if (opts.content && content) {
      for (const line of JSON.stringify(content, null, 2).split("\n")) lines.push(`${"  ".repeat(d + 2)}${line}`);
    }
  }
  return lines.join("\n");
}

export { fmtMs, fmtUsd };

import type { AttrValue, SpanContent, SpanData, SpanSink } from "./span.ts";

type OtlpValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }
  | { arrayValue: { values: OtlpValue[] } };
type OtlpAttr = { key: string; value: OtlpValue };

/** Content keys with a GenAI semantic-convention attribute; anything else goes under standin.content.<key>. */
const CONTENT_ATTRS: Record<string, string> = {
  system: "gen_ai.system_instructions",
  prompt: "gen_ai.input.messages",
  output: "gen_ai.output.messages",
};

function value(v: AttrValue): OtlpValue {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((s) => ({ stringValue: s })) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

const attrs = (a: Record<string, AttrValue>): OtlpAttr[] => Object.entries(a).map(([key, v]) => ({ key, value: value(v) }));
const unixNano = (iso: string): string => (BigInt(Date.parse(iso)) * 1_000_000n).toString();

/** OTLP/JSON (the protobuf JSON mapping: hex ids, nanosecond strings, int64 as strings). */
export function toOtlpJson(
  spans: { span: SpanData; content: SpanContent | null }[],
  opts: { serviceName: string; serviceVersion: string; includeContent: boolean },
): object {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ "service.name": opts.serviceName, "service.version": opts.serviceVersion }) },
        scopeSpans: [
          {
            scope: { name: "standin", version: opts.serviceVersion },
            spans: spans.map(({ span, content }) => {
              const contentAttrs: OtlpAttr[] =
                opts.includeContent && content
                  ? Object.entries(content).map(([k, v]) => ({
                      key: CONTENT_ATTRS[k] ?? `standin.content.${k}`,
                      value: { stringValue: JSON.stringify(v) },
                    }))
                  : [];
              return {
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: span.kind === "client" ? 3 : 1,
                startTimeUnixNano: unixNano(span.startTime),
                endTimeUnixNano: unixNano(span.endTime),
                attributes: [...attrs(span.attributes), ...contentAttrs],
                events: span.events.map((e) => ({ name: e.name, timeUnixNano: unixNano(e.time), attributes: attrs(e.attributes) })),
                status:
                  span.status.code === "ok"
                    ? { code: 1 }
                    : span.status.code === "error"
                      ? { code: 2, ...(span.status.message ? { message: span.status.message } : {}) }
                      : {},
              };
            }),
          },
        ],
      },
    ],
  };
}

export interface OtlpHttpSinkOptions {
  /** e.g. http://localhost:4318/v1/traces */
  endpoint: string;
  headers?: Record<string, string>;
  /** Prompts and outputs are exported only when true. */
  includeContent: boolean;
  serviceName?: string;
  serviceVersion?: string;
  /** Abort the export after this long, so a hung collector can't keep the process alive. Default 5000 ms. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Buffers each trace and posts it to an OTLP/HTTP collector when the trace's root span ends. */
export class OtlpHttpSink implements SpanSink {
  private readonly buffers = new Map<string, { span: SpanData; content: SpanContent | null }[]>();

  constructor(private readonly opts: OtlpHttpSinkOptions) {}

  onEnd(span: SpanData, content: SpanContent | null): void | Promise<void> {
    const buffer = this.buffers.get(span.traceId) ?? [];
    buffer.push({ span, content });
    if (span.parentSpanId !== null) {
      this.buffers.set(span.traceId, buffer);
      return;
    }
    this.buffers.delete(span.traceId);
    return this.post(buffer);
  }

  private async post(spans: { span: SpanData; content: SpanContent | null }[]): Promise<void> {
    const body = toOtlpJson(spans, {
      serviceName: this.opts.serviceName ?? "standin",
      serviceVersion: this.opts.serviceVersion ?? "0.1.0",
      includeContent: this.opts.includeContent,
    });
    const res = await (this.opts.fetch ?? globalThis.fetch)(this.opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000),
    });
    if (!res.ok) throw new Error(`OTLP export to ${this.opts.endpoint} returned ${res.status}`);
  }
}

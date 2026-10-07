export type AttrValue = string | number | boolean | string[];
export type MaybeAttrs = Record<string, AttrValue | null | undefined>;

export interface SpanEvent {
  name: string;
  time: string;
  attributes: Record<string, AttrValue>;
}

/** A finished span, shaped like an OpenTelemetry span. Times are ISO-8601 UTC. */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  kind: "internal" | "client";
  startTime: string;
  endTime: string;
  attributes: Record<string, AttrValue>;
  events: SpanEvent[];
  status: { code: "unset" | "ok" | "error"; message?: string };
}

/** Text a span carried (prompts, outputs). Kept apart from attributes so retention and export can treat it differently. */
export type SpanContent = Record<string, unknown>;

export interface SpanSink {
  /** Called once per span when it ends. May be async; the tracer waits (bounded) for a trace's sinks when its root ends. */
  onEnd(span: SpanData, content: SpanContent | null): void | Promise<void>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  /** null and undefined are ignored, so optional values can be passed straight through. */
  setAttribute(key: string, value: AttrValue | null | undefined): void;
  setAttributes(attrs: MaybeAttrs): void;
  addEvent(name: string, attributes?: Record<string, AttrValue>): void;
  /** Merged into the span's content. */
  setContent(content: SpanContent): void;
  setStatus(code: "ok" | "error", message?: string): void;
}

export function definedAttrs(attrs: MaybeAttrs | undefined): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

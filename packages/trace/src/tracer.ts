import { AsyncLocalStorage } from "node:async_hooks";
import { newSpanId, newTraceId } from "./ids.ts";
import { definedAttrs, type AttrValue, type MaybeAttrs, type Span, type SpanContent, type SpanData, type SpanEvent, type SpanSink } from "./span.ts";

export interface SpanOptions {
  kind?: "internal" | "client";
  attributes?: MaybeAttrs;
  /** Defaults to now. Batch results use the submission time. */
  startTime?: Date;
}

export interface TracerOptions {
  sinks: SpanSink[];
  clock?: { now(): Date };
  /** Sink failures never fail a run; they are reported here (default: console.error). */
  onSinkError?: (err: unknown, sink: SpanSink | null) => void;
  /** How long a run waits for async sinks when its root span ends. Default 5000 ms. */
  flushTimeoutMs?: number;
}

class SpanImpl implements Span {
  readonly spanId = newSpanId();
  readonly attributes: Record<string, AttrValue>;
  readonly events: SpanEvent[] = [];
  content: SpanContent | null = null;
  status: SpanData["status"] = { code: "unset" };

  constructor(
    readonly traceId: string,
    readonly parentSpanId: string | null,
    readonly name: string,
    readonly kind: "internal" | "client",
    readonly startTime: string,
    attributes: MaybeAttrs | undefined,
    private readonly now: () => string,
  ) {
    this.attributes = definedAttrs(attributes);
  }

  setAttribute(key: string, value: AttrValue | null | undefined): void {
    if (value !== null && value !== undefined) this.attributes[key] = value;
  }
  setAttributes(attrs: MaybeAttrs): void {
    Object.assign(this.attributes, definedAttrs(attrs));
  }
  addEvent(name: string, attributes: Record<string, AttrValue> = {}): void {
    this.events.push({ name, time: this.now(), attributes });
  }
  setContent(content: SpanContent): void {
    this.content = { ...this.content, ...content };
  }
  setStatus(code: "ok" | "error", message?: string): void {
    this.status = message === undefined ? { code } : { code, message };
  }

  finish(endTime: string): SpanData {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime,
      attributes: { ...this.attributes },
      events: [...this.events],
      status: { ...this.status },
    };
  }
}

/**
 * A small tracer that emits OpenTelemetry-shaped spans. The active span is
 * carried by AsyncLocalStorage (Node, and Workers with nodejs_compat), so
 * nested work finds its parent without a span parameter.
 */
export class Tracer {
  private readonly als = new AsyncLocalStorage<SpanImpl>();
  private readonly clock: { now(): Date };
  private readonly onSinkError: (err: unknown, sink: SpanSink | null) => void;
  private readonly pending = new Map<string, Promise<void>[]>();

  constructor(private readonly opts: TracerOptions) {
    this.clock = opts.clock ?? { now: () => new Date() };
    this.onSinkError = opts.onSinkError ?? ((err) => console.error("trace sink failed:", err));
  }

  /** A root span "standin.run" for one run of `kind`. Always starts a new trace, even inside another span. */
  run<T>(kind: string, attributes: MaybeAttrs, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.execute(null, "standin.run", { attributes: { "standin.run.kind": kind, ...attributes } }, fn);
  }

  /** A child of the active span (or a new root when none is active). A thrown error marks it failed and is rethrown. */
  span<T>(name: string, opts: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
    return this.execute(this.als.getStore() ?? null, name, opts, fn);
  }

  active(): Span | null {
    return this.als.getStore() ?? null;
  }

  private async execute<T>(parent: SpanImpl | null, name: string, opts: SpanOptions, fn: (span: Span) => Promise<T>): Promise<T> {
    const now = () => this.clock.now().toISOString();
    const span = new SpanImpl(
      parent?.traceId ?? newTraceId(),
      parent?.spanId ?? null,
      name,
      opts.kind ?? "internal",
      (opts.startTime ?? this.clock.now()).toISOString(),
      opts.attributes,
      now,
    );
    try {
      return await this.als.run(span, () => fn(span));
    } catch (err) {
      span.setStatus("error", err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this.emit(span.finish(now()), span.content);
      if (span.parentSpanId === null) await this.flush(span.traceId);
    }
  }

  private emit(data: SpanData, content: SpanContent | null): void {
    for (const sink of this.opts.sinks) {
      try {
        const result = sink.onEnd(data, content);
        if (result && typeof result.then === "function") {
          const list = this.pending.get(data.traceId) ?? [];
          list.push(Promise.resolve(result).catch((err) => this.onSinkError(err, sink)));
          this.pending.set(data.traceId, list);
        }
      } catch (err) {
        this.onSinkError(err, sink);
      }
    }
  }

  private async flush(traceId: string): Promise<void> {
    const list = this.pending.get(traceId);
    this.pending.delete(traceId);
    if (!list?.length) return;
    const ms = this.opts.flushTimeoutMs ?? 5000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), ms);
    });
    const outcome = await Promise.race([Promise.allSettled(list).then(() => "done" as const), timeout]);
    clearTimeout(timer);
    if (outcome === "timeout") this.onSinkError(new Error(`trace sink flush timed out after ${ms} ms`), null);
  }
}

/** A tracer with no sinks: spans cost almost nothing and go nowhere. */
export const noopTracer = new Tracer({ sinks: [] });

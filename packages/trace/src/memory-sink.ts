import type { SpanContent, SpanData, SpanSink } from "./span.ts";

/** Keeps every finished span in memory, for tests. */
export class MemorySink implements SpanSink {
  readonly spans: { span: SpanData; content: SpanContent | null }[] = [];
  onEnd(span: SpanData, content: SpanContent | null): void {
    this.spans.push({ span, content });
  }
}

import type { SpanContent, SpanData, SpanSink } from "@standin/trace";
import { AmbiguousIdError, NotFoundError } from "./errors.ts";
import type { Store } from "./store.ts";

export interface UsageRow {
  key: string;
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum over priced calls only; see `unpricedCalls`. */
  costUsd: number;
  unpricedCalls: number;
}

export interface RunSummary {
  traceId: string;
  kind: string;
  startTime: string;
  durationMs: number;
  status: "unset" | "ok" | "error";
  modelCalls: number;
  costUsd: number;
  unpricedCalls: number;
}

/** JSON path for an attribute key; keys contain dots, so they are quoted. */
const attr = (key: string) => `json_extract(attributes, '$."${key}"')`;
const ROLE = attr("standin.role");
const COST = attr("standin.cost_usd");

type SpanRow = {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: "internal" | "client";
  start_time: string;
  end_time: string;
  status: "unset" | "ok" | "error";
  status_message: string | null;
  attributes: string;
  events: string;
  content: string | null;
};

/** Writes each finished span (and its content, if any) synchronously. */
export function spanSink(s: Store): SpanSink {
  const insertSpan = s.db.prepare(
    `INSERT INTO spans (span_id, trace_id, parent_span_id, name, kind, start_time, end_time, status, status_message, attributes, events)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertContent = s.db.prepare("INSERT INTO span_content (span_id, recorded_at, content) VALUES (?, ?, ?)");
  return {
    onEnd(span: SpanData, content: SpanContent | null) {
      s.transaction(() => {
        insertSpan.run(
          span.spanId,
          span.traceId,
          span.parentSpanId,
          span.name,
          span.kind,
          span.startTime,
          span.endTime,
          span.status.code,
          span.status.message ?? null,
          JSON.stringify(span.attributes),
          JSON.stringify(span.events),
        );
        if (content !== null) insertContent.run(span.spanId, s.nowIso(), JSON.stringify(content));
      });
    },
  };
}

export function usage(s: Store, opts: { since?: string; by: "role" | "model" }): UsageRow[] {
  const key = opts.by === "role" ? ROLE : `COALESCE(${attr("gen_ai.response.model")}, ${attr("gen_ai.request.model")})`;
  const rows = s.db
    .prepare(
      `SELECT ${key} AS key,
              COUNT(*) AS calls,
              SUM(COALESCE(${attr("standin.outcome")}, 'ok') != 'ok') AS failed,
              SUM(COALESCE(${attr("gen_ai.usage.input_tokens")}, 0)) AS inputTokens,
              SUM(COALESCE(${attr("gen_ai.usage.output_tokens")}, 0)) AS outputTokens,
              SUM(COALESCE(${attr("gen_ai.usage.cache_read.input_tokens")}, 0)) AS cacheReadTokens,
              SUM(COALESCE(${attr("gen_ai.usage.cache_write.input_tokens")}, 0)) AS cacheWriteTokens,
              COALESCE(SUM(${COST}), 0) AS costUsd,
              SUM(${COST} IS NULL) AS unpricedCalls
       FROM spans
       WHERE ${ROLE} IS NOT NULL AND start_time >= ?
       GROUP BY key ORDER BY key`,
    )
    .all(opts.since ?? "") as unknown as UsageRow[];
  return rows.map((r) => ({ ...r, key: String(r.key ?? "(unknown)") }));
}

export function listRuns(s: Store, opts: { since?: string; kind?: string; limit?: number }): RunSummary[] {
  const rows = s.db
    .prepare(
      `SELECT r.trace_id, r.start_time, r.end_time, r.status, ${attr("standin.run.kind").replace("attributes", "r.attributes")} AS run_kind,
              (SELECT COUNT(*) FROM spans c WHERE c.trace_id = r.trace_id AND ${ROLE.replace("attributes", "c.attributes")} IS NOT NULL) AS modelCalls,
              (SELECT COALESCE(SUM(${COST.replace("attributes", "c.attributes")}), 0) FROM spans c WHERE c.trace_id = r.trace_id) AS costUsd,
              (SELECT COUNT(*) FROM spans c WHERE c.trace_id = r.trace_id AND ${ROLE.replace("attributes", "c.attributes")} IS NOT NULL
                 AND ${COST.replace("attributes", "c.attributes")} IS NULL) AS unpricedCalls
       FROM spans r
       WHERE r.parent_span_id IS NULL AND r.start_time >= ? AND (? IS NULL OR run_kind = ?)
       ORDER BY r.start_time DESC, r.rowid DESC
       LIMIT ?`,
    )
    .all(opts.since ?? "", opts.kind ?? null, opts.kind ?? null, opts.limit ?? -1) as {
    trace_id: string;
    start_time: string;
    end_time: string;
    status: RunSummary["status"];
    run_kind: string | null;
    modelCalls: number;
    costUsd: number;
    unpricedCalls: number;
  }[];
  return rows.map((r) => ({
    traceId: r.trace_id,
    kind: r.run_kind ?? "(none)",
    startTime: r.start_time,
    durationMs: Date.parse(r.end_time) - Date.parse(r.start_time),
    status: r.status,
    modelCalls: r.modelCalls,
    costUsd: r.costUsd,
    unpricedCalls: r.unpricedCalls,
  }));
}

export function lastTraceId(s: Store): string | null {
  const row = s.db.prepare("SELECT trace_id FROM spans WHERE parent_span_id IS NULL ORDER BY start_time DESC, rowid DESC LIMIT 1").get() as
    | { trace_id: string }
    | undefined;
  return row?.trace_id ?? null;
}

/** All spans of a trace in depth-first order (children by start time, then write order), so the tree renders top-down. */
export function getTrace(s: Store, idOrPrefix: string): { span: SpanData; content: SpanContent | null }[] {
  const prefix = idOrPrefix.trim().toLowerCase();
  if (prefix.length < 6) throw new Error(`trace id prefix must be at least 6 characters: "${idOrPrefix}"`);
  const ids = (s.db.prepare("SELECT DISTINCT trace_id FROM spans WHERE trace_id LIKE ? || '%' LIMIT 10").all(prefix) as { trace_id: string }[]).map(
    (r) => r.trace_id,
  );
  if (ids.length === 0) throw new NotFoundError("trace", idOrPrefix);
  if (ids.length > 1) throw new AmbiguousIdError(idOrPrefix, ids);

  const rows = s.db
    .prepare(
      `SELECT s.*, c.content FROM spans s LEFT JOIN span_content c ON c.span_id = s.span_id
       WHERE s.trace_id = ? ORDER BY s.start_time, s.rowid`,
    )
    .all(ids[0]!) as unknown as SpanRow[];
  const children = new Map<string | null, SpanRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_span_id) ?? [];
    list.push(r);
    children.set(r.parent_span_id, list);
  }
  const known = new Set(rows.map((r) => r.span_id));
  const out: { span: SpanData; content: SpanContent | null }[] = [];
  const visit = (r: SpanRow) => {
    out.push({ span: toSpan(r), content: r.content === null ? null : (JSON.parse(r.content) as SpanContent) });
    for (const c of children.get(r.span_id) ?? []) visit(c);
  };
  // Roots, plus orphans whose parent was never written (e.g. a crash mid-run).
  for (const r of rows) if (r.parent_span_id === null || !known.has(r.parent_span_id)) visit(r);
  return out;
}

function toSpan(r: SpanRow): SpanData {
  return {
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    name: r.name,
    kind: r.kind,
    startTime: r.start_time,
    endTime: r.end_time,
    attributes: JSON.parse(r.attributes),
    events: JSON.parse(r.events),
    status: r.status_message === null ? { code: r.status } : { code: r.status, message: r.status_message },
  };
}

/** Deletes stored span text recorded before `before`; span structure stays. */
export function purgeSpanContent(s: Store, before: string): number {
  return Number(s.db.prepare("DELETE FROM span_content WHERE recorded_at < ?").run(before).changes);
}

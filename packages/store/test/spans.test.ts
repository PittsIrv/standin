import { parseConfig } from "@standin/schema";
import { Tracer, type Span } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { AmbiguousIdError, NotFoundError } from "../src/index.ts";
import { tempStore } from "./helpers.ts";

const config = parseConfig({ persona: { name: "Lin Qiao" } });

function traced() {
  const env = tempStore();
  const tracer = new Tracer({ sinks: [env.store.spanSink()], clock: env.clock });
  return { ...env, tracer };
}

/** A model-call span like the router writes. */
async function chat(tracer: Tracer, role: string, model: string, attrs: { in: number; out: number; cost?: number; outcome?: string; cacheRead?: number }) {
  await tracer.span(`chat ${model}`, { kind: "client" }, async (span: Span) => {
    span.setAttributes({
      "standin.role": role,
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      "gen_ai.usage.input_tokens": attrs.in,
      "gen_ai.usage.output_tokens": attrs.out,
      "gen_ai.usage.cache_read.input_tokens": attrs.cacheRead ?? 0,
      "gen_ai.usage.cache_write.input_tokens": 0,
      "standin.cost_usd": attrs.cost,
      "standin.outcome": attrs.outcome ?? "ok",
    });
    span.setContent({ prompt: `prompt for ${role}`, output: { ok: true } });
  });
}

describe("trace storage", () => {
  it("round-trips spans and keeps content in its own table", async () => {
    const { store, tracer } = traced();
    await tracer.run("compaction", { "standin.compaction.mode": "live" }, async () => {
      await tracer.span("compaction.observation", {}, async (span) => {
        span.addEvent("note", { n: 1 });
        await chat(tracer, "extract", "claude-opus-5-5", { in: 100, out: 20, cost: 0.01 });
      });
    });
    const id = store.lastTraceId()!;
    const trace = store.getTrace(id);
    expect(trace.map((t) => t.span.name)).toEqual(["standin.run", "compaction.observation", "chat claude-opus-5-5"]);
    const [run, obs, call] = trace;
    expect(run!.span.attributes).toEqual({ "standin.run.kind": "compaction", "standin.compaction.mode": "live" });
    expect(obs!.span.events).toEqual([{ name: "note", time: "2026-10-01T12:00:00.000Z", attributes: { n: 1 } }]);
    expect(call!.span.parentSpanId).toBe(obs!.span.spanId);
    expect(call!.content).toEqual({ prompt: "prompt for extract", output: { ok: true } });
    expect(run!.content).toBeNull();
    const rawAttrs = store.db.prepare("SELECT attributes FROM spans WHERE name LIKE 'chat %'").get() as { attributes: string };
    expect(rawAttrs.attributes).not.toContain("prompt for extract");
  });

  it("totals usage by role and by model, counting unpriced and failed calls", async () => {
    const { store, tracer } = traced();
    await tracer.run("compaction", {}, async () => {
      await chat(tracer, "extract", "claude-opus-5-5", { in: 1000, out: 200, cost: 0.02, cacheRead: 500 });
      await chat(tracer, "reconcile", "claude-haiku-4-5", { in: 300, out: 10, cost: 0.001 });
      await chat(tracer, "reconcile", "qwen3:8b", { in: 280, out: 12, outcome: "invalid" });
    });
    const byRole = store.usage({ by: "role" });
    expect(byRole).toEqual([
      { key: "extract", calls: 1, failed: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 0, costUsd: 0.02, unpricedCalls: 0 },
      { key: "reconcile", calls: 2, failed: 1, inputTokens: 580, outputTokens: 22, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001, unpricedCalls: 1 },
    ]);
    expect(store.usage({ by: "model" }).map((r) => r.key)).toEqual(["claude-haiku-4-5", "claude-opus-5-5", "qwen3:8b"]);
    expect(store.usage({ by: "role", since: "2027-01-01T00:00:00.000Z" })).toEqual([]);
  });

  it("summarizes runs newest first, with cost over descendants", async () => {
    const { store, tracer, clock } = traced();
    await tracer.run("compaction", {}, async () => chat(tracer, "extract", "m", { in: 1, out: 1, cost: 0.5 }));
    clock.advanceDays(1);
    await tracer.run("import", {}, async () => {
      await tracer.span("x", {}, async () => {
        await chat(tracer, "extract", "m", { in: 1, out: 1, cost: 0.25 });
        await chat(tracer, "extract", "m", { in: 1, out: 1 });
      });
    });
    const runs = store.listRuns({});
    expect(runs.map((r) => [r.kind, r.modelCalls, r.costUsd, r.unpricedCalls])).toEqual([
      ["import", 2, 0.25, 1],
      ["compaction", 1, 0.5, 0],
    ]);
    expect(runs[0]!.durationMs).toBe(0);
    expect(store.listRuns({ kind: "compaction" })).toHaveLength(1);
    expect(store.listRuns({ limit: 1 })).toHaveLength(1);
  });

  it("finds traces by unique prefix and reports ambiguity or absence", async () => {
    const { store, tracer } = traced();
    for (let i = 0; i < 3; i++) await tracer.run("compaction", {}, async () => {});
    const ids = store.listRuns({}).map((r) => r.traceId);
    expect(store.getTrace(ids[0]!.slice(0, 12))).toHaveLength(1);
    store.db.exec("UPDATE spans SET trace_id = 'abcdef' || substr(trace_id, 7)");
    expect(() => store.getTrace("abcdef")).toThrow(AmbiguousIdError);
    expect(() => store.getTrace("ffffffffffff")).toThrow(NotFoundError);
    expect(() => store.getTrace("ab")).toThrow(/at least 6/);
  });

  it("consolidate purges old trace text but keeps structure and usage", async () => {
    const { store, tracer, clock } = traced();
    await tracer.run("compaction", {}, async () => chat(tracer, "extract", "m", { in: 10, out: 5, cost: 0.1 }));
    const before = store.usage({ by: "role" });
    clock.advanceDays(config.consolidation.retentionDays + 1);
    await tracer.run("compaction", {}, async () => chat(tracer, "extract", "m", { in: 1, out: 1, cost: 0.1 }));
    const report = store.consolidate(config);
    expect(report.purgedSpanContent).toBe(1);
    const [newer, older] = store.listRuns({}).map((r) => store.getTrace(r.traceId));
    expect(older!.map((s) => s.span.name)).toEqual(["standin.run", "chat m"]);
    expect(older![1]!.content).toBeNull();
    expect(newer![1]!.content).not.toBeNull();
    expect(store.usage({ by: "role" })[0]!.inputTokens).toBe(before[0]!.inputTokens + 1);
  });

  it("purges trace text as soon as its observation's raw text is purged, even if the trace is newer", async () => {
    const { store, tracer, clock } = traced();
    const o = store.addObservation({
      sourceKind: "interview",
      sourceRef: "i",
      authorRole: "self",
      lang: "en",
      text: "My private answer.",
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    const other = store.addObservation({
      sourceKind: "interview",
      sourceRef: "i",
      authorRole: "self",
      lang: "en",
      text: "Another answer.",
      occurredAt: "2026-09-01T00:00:00.000Z",
    });
    // Compacted 80 days after import: the trace is much newer than the observation.
    clock.advanceDays(80);
    await tracer.run("compaction", {}, async () => {
      for (const obs of [o, other]) {
        await tracer.span("compaction.observation", { attributes: { "standin.observation.id": obs.id } }, async () => {
          await chat(tracer, "extract", "m", { in: 1, out: 1 });
        });
      }
      await tracer.span("chat m", { attributes: { "standin.batch.custom_id": o.id } }, async (span) => span.setContent({ output: "batched" }));
    });
    store.markCompacted(o.id, "processed");
    clock.advanceDays(11); // o's raw text is now past retention; the trace text is only 11 days old
    store.consolidate(config);
    expect(store.getObservation(o.id).text).toBeNull();
    const trace = store.getTrace(store.lastTraceId()!);
    const contentOf = (pred: (s: (typeof trace)[number]) => boolean) => trace.filter(pred).map((s) => s.content);
    const underObs = (id: string) => {
      const parent = trace.find((s) => s.span.attributes["standin.observation.id"] === id)!.span.spanId;
      return contentOf((s) => s.span.parentSpanId === parent);
    };
    expect(underObs(o.id)).toEqual([null]);
    expect(contentOf((s) => s.span.attributes["standin.batch.custom_id"] === o.id)).toEqual([null]);
    // The other observation was never compacted, so its raw text and trace text both stay.
    expect(underObs(other.id)).not.toEqual([null]);
  });
});

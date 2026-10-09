import { TracedModel } from "@standin/models";
import { MemorySink, Tracer, type SpanData } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { compact, compactBatch } from "../src/index.ts";
import { config, extraction, obs, script, tempStore } from "./helpers.ts";

function traced(llm: ReturnType<typeof script>) {
  const sink = new MemorySink();
  const tracer = new Tracer({ sinks: [sink] });
  const extract = new TracedModel(llm, { role: "extract", tier: "large", tracer, prices: {} });
  const reconcile = new TracedModel(llm, { role: "reconcile", tier: "small", tracer, prices: {} });
  const spans = () => sink.spans.map((s) => s.span);
  const byId = (id: string | null) => spans().find((s) => s.spanId === id);
  const childrenOf = (s: SpanData) => spans().filter((c) => c.parentSpanId === s.spanId);
  return { tracer, extract, reconcile, spans, byId, childrenOf };
}

describe("compaction traces", () => {
  it("records one run with a span per observation, its model calls and its store write", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I build board-game AIs."));
    const b = store.addObservation(obs("I make game AIs for board games.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    const llm = script(
      {
        [a.text!]: extraction([{ statement: "I build board-game AIs." }]),
        [b.text!]: extraction([{ statement: "I build AIs for board games." }]),
      },
      (_c, neighbors) => (neighbors[0] ? { action: "duplicate", targetId: neighbors[0], reason: "" } : { action: "new", targetId: null, reason: "" }),
    );
    const t = traced(llm);
    await compact({ store, llm: t.extract, reconcileLLM: t.reconcile, config, tracer: t.tracer });

    const roots = t.spans().filter((s) => s.parentSpanId === null);
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.attributes).toMatchObject({
      "standin.run.kind": "compaction",
      "standin.compaction.mode": "live",
      "standin.compaction.processed": 2,
      "standin.compaction.failed": 0,
      "standin.compaction.created": 1,
    });
    const observations = t.childrenOf(root);
    expect(observations.map((s) => [s.name, s.attributes["standin.observation.id"]])).toEqual([
      ["compaction.observation", a.id],
      ["compaction.observation", b.id],
    ]);
    expect(t.childrenOf(observations[0]!).map((s) => s.name)).toEqual(["chat scripted", "store.apply"]);
    // b's candidate had a neighbor, so its reconcile call sits under b.
    expect(t.childrenOf(observations[1]!).map((s) => [s.name, s.attributes["standin.role"] ?? null])).toEqual([
      ["chat scripted", "extract"],
      ["chat scripted", "reconcile"],
      ["store.apply", null],
    ]);
  });

  it("marks a failed observation's span as an error and counts it on the run", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("Boom."));
    const llm = script({
      [a.text!]: () => {
        throw new Error("overloaded");
      },
    });
    const t = traced(llm);
    const report = await compact({ store, llm: t.extract, config, tracer: t.tracer });
    expect(report.failed).toHaveLength(1);
    const observation = t.spans().find((s) => s.name === "compaction.observation")!;
    expect(observation.status.code).toBe("error");
    expect(observation.status.message).toContain("overloaded");
    expect(t.spans().find((s) => s.parentSpanId === null)!.attributes["standin.compaction.failed"]).toBe(1);
  });

  it("traces batch submit and collect as separate runs, with extraction spans started at submission", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I build board-game AIs."));
    const llm = script({ [a.text!]: extraction([{ statement: "I build board-game AIs." }]) }, undefined, { batchPolls: 1 });
    const t = traced(llm);
    const opts = { store, llm: t.extract, reconcileLLM: t.reconcile, config, modelLabel: "scripted", tracer: t.tracer };
    await compactBatch(opts);
    await compactBatch(opts); // still processing: no run recorded for a status poll
    await compactBatch(opts);
    const roots = t.spans().filter((s) => s.parentSpanId === null);
    expect(roots.map((r) => r.attributes["standin.compaction.mode"])).toEqual(["batch-submit", "batch-collect"]);
    const submittedAt = store.db.prepare("SELECT submitted_at FROM compaction_batches").get() as { submitted_at: string };
    const batched = t.spans().find((s) => s.attributes["standin.batch"] === true)!;
    expect(batched.startTime).toBe(submittedAt.submitted_at);
    // Batch results arrive together, so their spans hang off the collect run, keyed to their observation.
    expect(batched.parentSpanId).toBe(roots[1]!.spanId);
    expect(batched.attributes["standin.batch.custom_id"]).toBe(a.id);
  });

  it("works unchanged without a tracer", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("Hello."));
    const llm = script({ [a.text!]: extraction([{ statement: "I say hello." }]) });
    expect(await compact({ store, llm, config })).toMatchObject({ processed: 1, created: 1 });
  });
});

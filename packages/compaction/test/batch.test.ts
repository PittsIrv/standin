import { describe, expect, it } from "vitest";
import { abandonBatch, compact, compactBatch } from "../src/index.ts";
import { config, extraction, obs, script, tempStore } from "./helpers.ts";

describe("compactBatch", () => {
  it("submits extraction, reports processing, then collects with live, in-order reconciliation", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("I build board-game AIs."));
    const b = store.addObservation(obs("I make game AIs for board games.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    store.addObservation(obs("Lab announcement.", { authorRole: "exposed", sourceKind: "slack" }));
    const llm = script(
      {
        [a.text!]: extraction([{ statement: "I build board-game AIs." }]),
        [b.text!]: extraction([{ statement: "I build AIs for board games." }]),
      },
      // b's candidate can only see a's memory if a was applied first.
      (_c, neighbors) => (neighbors[0] ? { action: "duplicate", targetId: neighbors[0], reason: "" } : { action: "new", targetId: null, reason: "" }),
      { batchPolls: 1 },
    );
    const opts = { store, llm, config, modelLabel: "test" };

    const submitted = await compactBatch(opts);
    expect(submitted).toMatchObject({ kind: "submitted", observations: 2, skippedExposed: 1 });
    expect(llm.calls).toHaveLength(0);
    expect(store.openCompactionBatch()?.observationIds).toEqual([a.id, b.id]);
    // Observations in an open batch are not handed to live compaction.
    expect(store.uncompactedObservations(10)).toEqual([]);

    expect(await compactBatch(opts)).toMatchObject({ kind: "processing" });
    const collected = await compactBatch(opts);
    expect(collected).toMatchObject({ kind: "collected", report: { processed: 2, created: 1, corroborated: 1, failed: [] } });
    expect(store.openCompactionBatch()).toBeNull();
    expect(await compactBatch(opts)).toEqual({ kind: "idle", skippedExposed: 0 });
  });

  it("marks failed results failed, and resumes a collection that was interrupted", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("First."));
    const b = store.addObservation(obs("Second.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    const llm = script({
      [a.text!]: extraction([{ statement: "First thing." }]),
      [b.text!]: () => {
        throw new Error("overloaded");
      },
    });
    const opts = { store, llm, config, modelLabel: "test" };
    await compactBatch(opts);
    // Simulate a crash after `a` was applied: mark it compacted by hand.
    store.markCompacted(a.id, "processed");
    const step = await compactBatch(opts);
    expect(step).toMatchObject({ kind: "collected", report: { processed: 0, created: 0 } });
    if (step.kind !== "collected") throw new Error("unreachable");
    expect(step.report.failed).toEqual([{ observationId: b.id, error: expect.stringContaining("overloaded") }]);
    expect(store.uncompactedObservations(10, { retryFailed: true }).map((o) => o.id)).toEqual([b.id]);
  });

  it("abandoning returns observations to live compaction", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("Hello."));
    const llm = script({ [a.text!]: extraction([{ statement: "I say hello." }]) });
    await compactBatch({ store, llm, config, modelLabel: "test" });
    expect(abandonBatch(store)).toMatch(/^scripted_batch_/);
    expect(abandonBatch(store)).toBeNull();
    expect(await compact({ store, llm, config })).toMatchObject({ processed: 1, created: 1 });
  });

  it("uses a separate reconciliation model when given one", async () => {
    const { store } = tempStore();
    const a = store.addObservation(obs("One."));
    const b = store.addObservation(obs("Two.", { occurredAt: "2026-09-02T00:00:00.000Z" }));
    const extractor = script({ [a.text!]: extraction([{ statement: "I like one." }]), [b.text!]: extraction([{ statement: "I like one too." }]) });
    const reconciler = script({});
    await compact({ store, llm: extractor, reconcileLLM: reconciler, config });
    expect(extractor.calls.every((c) => c.purpose === "extract")).toBe(true);
    expect(reconciler.calls.map((c) => c.purpose)).toEqual(["reconcile"]);
  });
});

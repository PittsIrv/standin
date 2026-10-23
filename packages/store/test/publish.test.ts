import { describe, expect, it } from "vitest";
import { NotFoundError } from "../src/index.ts";
import { seedMemory, tempStore } from "./helpers.ts";

describe("publish reviews (publish spec §4–§5)", () => {
  it("records the sensitivity check per item and content, then the person's decision", () => {
    const { store } = tempStore();
    expect(store.getPublishReview("memory:m1")).toBeNull();
    store.recordSensitivity("memory:m1", "h1", { flagged: true, reason: "health" });
    expect(store.getPublishReview("memory:m1")).toMatchObject({ itemKey: "memory:m1", contentHash: "h1", flagged: true, reason: "health", decision: null });
    store.decidePublishReview("memory:m1", "keep");
    expect(store.getPublishReview("memory:m1")).toMatchObject({ decision: "keep" });
    // New text is a new check: the old decision no longer applies.
    store.recordSensitivity("memory:m1", "h2", { flagged: false, reason: null });
    expect(store.getPublishReview("memory:m1")).toMatchObject({ contentHash: "h2", flagged: false, decision: null });
    expect(store.listPublishReviews()).toHaveLength(1);
    expect(() => store.decidePublishReview("memory:unchecked", "keep")).toThrow(NotFoundError);
  });

  it("re-tiers an approved memory and logs it", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "I see a physio weekly.");
    store.approve(m.id);
    expect(store.retier(m.id, 3, "hidden at publish").tier).toBe(3);
    expect(store.memoryEvents(m.id).at(-1)).toMatchObject({ fromStatus: "approved", toStatus: "approved", actor: "person", note: "tier 1 → 3: hidden at publish" });
  });

  it("rejects an approved exemplar, but never approves a rejected one", () => {
    const { store } = tempStore();
    const o = store.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "x", occurredAt: "2026-09-01T00:00:00.000Z" });
    const e = store.insertExemplar({ observationId: o.id, text: "ugh physio again lol", register: "casual" })!;
    store.approveExemplar(e.id);
    expect(store.rejectExemplar(e.id).status).toBe("rejected");
    expect(() => store.approveExemplar(e.id)).toThrow(/cannot go from rejected/);
  });
});

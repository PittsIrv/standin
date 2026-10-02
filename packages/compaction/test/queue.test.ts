import { describe, expect, it } from "vitest";
import { reviewQueue } from "../src/index.ts";
import { obs, tempStore } from "./helpers.ts";

describe("reviewQueue", () => {
  it("puts contradictions first, then orders by salience, capped", () => {
    const { store } = tempStore();
    const o = store.addObservation(obs("seed"));
    const ins = (statement: string, salience: number, conflictsWithId: string | null = null) =>
      store.insertMemory(
        { kind: "fact", statement, lang: "en", tier: 1, isCurrentState: false, attrs: {}, conflictsWithId },
        { sourceObservationIds: [o.id], entityIds: [], actor: "compaction", salience },
      );
    const low = ins("low", 0.2);
    const high = ins("high", 2);
    const mid = ins("mid", 1);
    store.approve(mid.id);
    const conflict = ins("conflict", 0.1, mid.id);
    const approved = ins("already approved", 5);
    store.approve(approved.id);

    expect(reviewQueue(store, { cap: 10 }).map((m) => m.statement)).toEqual(["conflict", "high", "low"]);
    expect(reviewQueue(store, { cap: 2 }).map((m) => m.id)).toEqual([conflict.id, high.id]);
    expect(low.status).toBe("proposed");
  });
});

import { describe, expect, it } from "vitest";
import { seedMemory, tempStore } from "./helpers.ts";

describe("memoriesAsOf", () => {
  it("replays status by record time and validity by valid time", () => {
    const { store, clock } = tempStore();
    const t0 = clock.now();
    const a = seedMemory(store, "I live in Pittsburgh.", { validFrom: t0.toISOString() });
    clock.advanceDays(1);
    store.approve(a.id);
    const t1 = clock.now();

    clock.advanceDays(10);
    const t1_5 = clock.now();
    clock.advanceDays(10);
    const b = seedMemory(store, "I live in Seattle.", { supersedesId: a.id });
    store.approve(b.id);
    const t2 = clock.now();
    clock.advanceDays(10);
    const t3 = clock.now();

    const ids = (validAt: Date, recordedAt: Date) => store.memoriesAsOf({ validAt, recordedAt }).map((m) => m.id);

    // What we believed back then about back then.
    expect(ids(t1_5, t1_5)).toEqual([a.id]);
    // What we believe now about now.
    expect(ids(t3, t3)).toEqual([b.id]);
    // What we believe now about back then: A was true then, B not yet.
    expect(ids(t1_5, t3)).toEqual([a.id]);
    // Before A's valid time, nothing.
    expect(ids(new Date(t0.getTime() - 86_400_000), t3)).toEqual([]);
    // Before anything was approved, nothing.
    expect(ids(t1, new Date(t0.getTime() + 1000))).toEqual([]);
    // Defaults recordedAt to now.
    expect(store.memoriesAsOf({ validAt: t2 }).map((m) => m.id)).toEqual([b.id]);
  });

  it("excludes retracted memories after retraction but not before", () => {
    const { store, clock } = tempStore();
    const a = seedMemory(store, "Wrong fact.");
    store.approve(a.id);
    clock.advanceDays(1);
    const before = clock.now();
    clock.advanceDays(1);
    store.retract(a.id);
    expect(store.memoriesAsOf({ validAt: before, recordedAt: before }).map((m) => m.id)).toEqual([a.id]);
    expect(store.memoriesAsOf({ validAt: before })).toEqual([]);
  });
});

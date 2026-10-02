import { parseConfig } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { obs, seedMemory, tempStore } from "./helpers.ts";

const config = parseConfig({ persona: { name: "Lin Qiao" } });

describe("consolidate", () => {
  it("expires approved memories whose validity has ended", () => {
    const { store, clock } = tempStore();
    const m = seedMemory(store, "I'm a TA this fall.", { validUntil: "2026-12-15T00:00:00.000Z" });
    store.approve(m.id);
    const keep = seedMemory(store, "I was born in Chengdu.");
    store.approve(keep.id);
    clock.current = new Date("2026-12-20T00:00:00.000Z");
    const report = store.consolidate(config);
    expect(report.expired).toEqual([m.id]);
    expect(store.getMemory(m.id).status).toBe("expired");
    expect(store.memoryEvents(m.id).at(-1)).toMatchObject({ toStatus: "expired", actor: "consolidation" });
    expect(store.getMemory(keep.id).status).toBe("approved");
  });

  it("expires stale current-state memories but not stable facts", () => {
    const { store, clock } = tempStore();
    const reading = seedMemory(store, "I'm currently reading Solaris.", { isCurrentState: true });
    store.approve(reading.id);
    const stable = seedMemory(store, "I studied at CMU.");
    store.approve(stable.id);
    clock.advanceDays(119);
    expect(store.consolidate(config).expired).toEqual([]);
    clock.advanceDays(2);
    expect(store.consolidate(config).expired).toEqual([reading.id]);
    expect(store.getMemory(reading.id).validUntil).toBe(clock.now().toISOString());
    expect(store.getMemory(stable.id).status).toBe("approved");
  });

  it("recomputes confidence so proposed current-state claims decay", () => {
    const { store, clock } = tempStore();
    const o = store.addObservation(obs({ sourceKind: "chatgpt-memory", text: "User is currently learning Rust." }));
    const m = store.insertMemory(
      { kind: "fact", statement: "I'm currently learning Rust.", lang: "en", tier: 2, isCurrentState: true, attrs: {} },
      { sourceObservationIds: [o.id], entityIds: [], actor: "compaction", salience: 1 },
    );
    expect(m.confidence).toBeCloseTo(0.4, 10);
    clock.advanceDays(90);
    const report = store.consolidate(config);
    expect(report.recomputed).toBe(1);
    expect(store.getMemory(m.id).confidence).toBeCloseTo(0.2, 10);
  });

  it("purges old compacted observations but keeps their hash and links", () => {
    const { store, clock } = tempStore();
    const old = store.addObservation(obs({ text: "old compacted" }));
    const pending = store.addObservation(obs({ text: "old but never compacted" }));
    store.markCompacted(old.id, "processed");
    const m = store.insertMemory(
      { kind: "fact", statement: "Old fact.", lang: "en", tier: 1, isCurrentState: false, attrs: {} },
      { sourceObservationIds: [old.id], entityIds: [], actor: "compaction", salience: 1 },
    );
    clock.advanceDays(91);
    const report = store.consolidate(config);
    expect(report.purged).toBe(1);
    const purged = store.getObservation(old.id);
    expect(purged.text).toBeNull();
    expect(purged.purgedAt).toBe(clock.now().toISOString());
    expect(purged.contentHash).toBe(old.contentHash);
    expect(store.memorySources(m.id).map((o) => o.id)).toEqual([old.id]);
    expect(store.getObservation(pending.id).text).toBe("old but never compacted");
    // Re-adding purged content stays idempotent.
    expect(store.addObservation(obs({ text: "old compacted" })).id).toBe(old.id);
  });
});

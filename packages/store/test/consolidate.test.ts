import { parseConfig } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { obs, seedMemory, tempStore } from "./helpers.ts";

const config = parseConfig({ persona: { name: "Lin Qiao" } });
const purging = parseConfig({ persona: { name: "Lin Qiao" }, consolidation: { purgeAfterDays: 90 } });

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

  it("with purgeAfterDays set, purges old compacted observations but keeps their hash and links", () => {
    const { store, clock } = tempStore();
    const old = store.addObservation(obs({ text: "old compacted" }));
    const pending = store.addObservation(obs({ text: "old but never compacted" }));
    store.markCompacted(old.id, "processed");
    const m = store.insertMemory(
      { kind: "fact", statement: "Old fact.", tier: 1, isCurrentState: false, attrs: {} },
      { sourceObservationIds: [old.id], entityIds: [], actor: "compaction" },
    );
    clock.advanceDays(91);
    const report = store.consolidate(purging);
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

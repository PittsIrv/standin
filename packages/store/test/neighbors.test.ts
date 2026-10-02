import { describe, expect, it } from "vitest";
import { seedMemory, tempStore } from "./helpers.ts";

describe("findNeighbors", () => {
  it("ranks shared-entity memories above purely textual matches", () => {
    const { store } = tempStore();
    const e = store.resolveEntity({ name: "Dealer's Choice", kind: "project" });
    const textual = seedMemory(store, "I like playing poker with friends on weekends.");
    const linked = seedMemory(store, "It has twelve variants.", {}, [e.id]);
    const res = store.findNeighbors({ statement: "I like playing poker with friends.", entityIds: [e.id] });
    expect(res.map((r) => r.memory.id)).toEqual([linked.id, textual.id]);
  });

  it("includes rejected memories but not superseded ones", () => {
    const { store } = tempStore();
    const rej = seedMemory(store, "I hate poker.");
    store.reject(rej.id);
    const old = seedMemory(store, "I love poker a lot.");
    store.approve(old.id);
    const upd = seedMemory(store, "I love poker a lot, especially variants.", { supersedesId: old.id });
    store.approve(upd.id);
    const ids = store.findNeighbors({ statement: "I love poker a lot.", entityIds: [] }).map((r) => r.memory.id);
    expect(ids).toContain(upd.id);
    expect(ids).not.toContain(old.id);
    expect(store.findNeighbors({ statement: "I hate poker.", entityIds: [] }).map((r) => r.memory.id)).toContain(rej.id);
  });

  it("matches CJK statements", () => {
    const { store } = tempStore();
    const m = seedMemory(store, "我喜欢德州扑克。", { lang: "zh" });
    const res = store.findNeighbors({ statement: "我很喜欢德州扑克", entityIds: [] });
    expect(res[0]?.memory.id).toBe(m.id);
  });

  it("respects limit and threshold", () => {
    const { store } = tempStore();
    for (let i = 0; i < 12; i++) seedMemory(store, `I like poker variant ${i}`);
    seedMemory(store, "Completely unrelated sentence about gardening.");
    const res = store.findNeighbors({ statement: "I like poker variant", entityIds: [] }, { limit: 5 });
    expect(res).toHaveLength(5);
    expect(res.every((r) => r.score >= 0.3)).toBe(true);
  });
});

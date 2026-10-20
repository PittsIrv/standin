import { describe, expect, it } from "vitest";
import { CycleError, NotFoundError } from "../src/index.ts";
import { seedMemory, tempStore } from "./helpers.ts";

describe("topics", () => {
  it("creates a topic once, matching names and aliases, and keeps its definition", () => {
    const { store } = tempStore();
    const a = store.ensureTopic("Reinforcement learning", "Learning from rewards.");
    expect(store.ensureTopic("reinforcement  learning").id).toBe(a.id);
    expect(store.getTopic(a.id)).toMatchObject({ name: "Reinforcement learning", definition: "Learning from rewards.", deletedAt: null });
    expect(store.listTopics().map((t) => t.id)).toEqual([a.id]);
  });
});

describe("edges", () => {
  it("returns null for a duplicate and refuses cycles within one kind, naming the path", () => {
    const { store } = tempStore();
    const [a, b, c] = ["A", "B", "C"].map((n) => store.ensureTopic(n));
    expect(store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" })).not.toBeNull();
    expect(store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" })).toBeNull();
    store.addEdge({ from: b!.id, to: c!.id, kind: "part_of", source: "placement" });
    expect(() => store.addEdge({ from: c!.id, to: a!.id, kind: "part_of", source: "placement" })).toThrow(CycleError);
    expect(() => store.addEdge({ from: c!.id, to: a!.id, kind: "part_of", source: "placement" })).toThrow("C → A → B → C");
    // The same pair in the other kind is fine: part_of and requires are separate graphs.
    expect(store.addEdge({ from: c!.id, to: a!.id, kind: "requires", source: "expansion" })).not.toBeNull();
    expect(store.listEdges("part_of")).toHaveLength(2);
  });

  it("never re-adds edges to a deleted topic, and hides it", () => {
    const { store, clock } = tempStore();
    const [a, b] = ["A", "B"].map((n) => store.ensureTopic(n));
    store.setTopic(b!.id, { deletedAt: clock.now().toISOString() });
    expect(store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" })).toBeNull();
    expect(store.listTopics().map((t) => t.name)).toEqual(["A"]);
    expect(store.ensureTopic("B").deletedAt).not.toBeNull();
  });
});

describe("mergeTopics", () => {
  it("moves memory links, edges and gaps to the survivor and keeps the old name as an alias", () => {
    const { store } = tempStore();
    const rl = store.ensureTopic("RL");
    const full = store.ensureTopic("reinforcement learning");
    const ml = store.ensureTopic("machine learning");
    store.addEdge({ from: rl.id, to: ml.id, kind: "part_of", source: "placement" });
    const claim = seedMemory(store, "I know RL well.", { kind: "competence", attrs: { domain: "RL", depth: 3 } } as never, [rl.id]);
    store.addGap({ nodeId: rl.id, claimNodeId: null, level: 1, status: "kept", source: "stated", memoryId: claim.id });

    store.mergeTopics(rl.id, full.id);
    expect(() => store.getTopic(rl.id)).toThrow(NotFoundError);
    expect(store.getTopic(full.id).aliases).toContain("RL");
    expect(store.topicMemories(full.id).map((m) => m.id)).toEqual([claim.id]);
    expect(store.listEdges("part_of").map((e) => [e.from, e.to])).toEqual([[full.id, ml.id]]);
    expect(store.listGaps().map((g) => g.nodeId)).toEqual([full.id]);
  });

  it("drops self-loops a merge would create", () => {
    const { store } = tempStore();
    const [a, b] = ["A", "B"].map((n) => store.ensureTopic(n));
    store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" });
    store.mergeTopics(a!.id, b!.id);
    expect(store.listEdges()).toEqual([]);
  });
});

describe("gaps", () => {
  it("records a gap once per node and memory", () => {
    const { store } = tempStore();
    const n = store.ensureTopic("Rust macros");
    const m = seedMemory(store, "I can't write Rust macros yet.", { kind: "negative" } as never);
    const g = { nodeId: n.id, claimNodeId: null, level: 1, status: "kept" as const, source: "stated" as const, memoryId: m.id };
    expect(store.addGap(g)).toMatchObject({ level: 1, status: "kept" });
    expect(store.addGap(g)).toBeNull();
  });
});

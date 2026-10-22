import { describe, expect, it } from "vitest";
import { CycleError, NameTakenError, NotFoundError, RootEditError } from "../src/index.ts";
import { obs } from "./helpers.ts";
import { seedMemory, tempStore } from "./helpers.ts";

describe("topics", () => {
  it("creates a topic once, matching names and aliases, and keeps its definition", () => {
    const { store } = tempStore();
    const a = store.ensureTopic("Reinforcement learning", "Learning from rewards.");
    expect(store.ensureTopic("reinforcement  learning").id).toBe(a.id);
    expect(store.getTopic(a.id)).toMatchObject({ name: "Reinforcement learning", definition: "Learning from rewards.", deletedAt: null });
    expect(store.listTopics().map((t) => t.id)).toEqual([a.id]);
  });

  it("keeps an anchor on a node, finds the node by it, and moves a node without claiming the person did", () => {
    const { store } = tempStore();
    const cs = store.setTopic(store.ensureTopic("Computer Science").id, { anchor: "openalex:field:17" });
    expect(store.findByAnchor("openalex:field:17")?.id).toBe(cs.id);
    expect(store.findByAnchor("openalex:field:99")).toBeNull();
    const rl = store.ensureTopic("RL");
    expect(store.moveTopic(rl.id, cs.id, "anchor")).toMatchObject({ to: cs.id, source: "anchor" });
    expect(store.moveTopic(rl.id, store.root("knowledge").id)).toMatchObject({ source: "person" });
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

describe("world tree", () => {
  it("has six roots, and nodes of different labels never collide", () => {
    const { store } = tempStore();
    expect(store.roots().map((r) => r.rootKey)).toEqual(["knowledge", "work", "background", "people", "views", "life"]);
    expect(store.ensureNode("Miso", "pet").id).not.toBe(store.ensureNode("Miso", "topic").id);
    expect(store.ensureTopic("Rust").label).toBe("topic");
  });

  it("keeps one home per node, never gives a root a parent, and stores related links undirected", () => {
    const { store } = tempStore();
    const [a, b, c] = ["A", "B", "C"].map((n) => store.ensureTopic(n));
    expect(store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" })).not.toBeNull();
    expect(store.addEdge({ from: a!.id, to: c!.id, kind: "part_of", source: "placement" })).toBeNull();
    expect(store.homeParent(a!.id)).toBe(b!.id);
    expect(store.addEdge({ from: store.root("life").id, to: c!.id, kind: "part_of", source: "placement" })).toBeNull();
    const [lo, hi] = [b!.id, c!.id].sort();
    const r = store.addEdge({ from: hi!, to: lo!, kind: "related", source: "placement" })!;
    expect([r.from, r.to]).toEqual([lo, hi]);
    expect(store.addEdge({ from: lo!, to: hi!, kind: "related", source: "placement" })).toBeNull();
  });

  it("walks home parents to a root", () => {
    const { store } = tempStore();
    const pets = store.ensureNode("Pets", "other");
    const miso = store.ensureNode("Miso", "pet");
    store.addEdge({ from: pets.id, to: store.root("life").id, kind: "part_of", source: "placement" });
    store.addEdge({ from: miso.id, to: pets.id, kind: "part_of", source: "placement" });
    expect(store.rootOf(miso.id)).toBe("life");
    expect(store.rootOf(store.root("work").id)).toBe("work");
    expect(store.rootOf(store.ensureTopic("Loose").id)).toBeNull();
  });

  it("gives memories a home, lists them by home, and clears frontier when a memory links a node", () => {
    const { store } = tempStore();
    const pets = store.ensureNode("Pets", "other");
    const ppo = store.setTopic(store.ensureTopic("PPO").id, { frontier: true });
    expect(ppo.frontier).toBe(true);
    const o = store.addObservation(obs());
    const m = store.insertMemory(
      { kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} },
      { sourceObservationIds: [o.id], entityIds: [pets.id, ppo.id], actor: "compaction", homeNodeId: pets.id },
    );
    expect(m.homeNodeId).toBe(pets.id);
    expect(store.nodeMemories(pets.id).map((x) => x.id)).toEqual([m.id]);
    expect(store.getTopic(ppo.id).frontier).toBe(false);
    const other = store.ensureNode("Cats", "other");
    expect(store.setHome(m.id, other.id).homeNodeId).toBe(other.id);
  });

  it("clears frontier when a probe is written for the node", () => {
    const { store } = tempStore();
    const n = store.setTopic(store.ensureTopic("PPO").id, { frontier: true });
    store.insertProbe({ nodeId: n.id, checkOf: null, kind: "foundation", difficulty: 2, question: "Q?", holdout: "none" });
    expect(store.getTopic(n.id).frontier).toBe(false);
  });

  it("renames, keeping the old name as an alias, and refuses a name another node of that label has", () => {
    const { store } = tempStore();
    const rl = store.ensureTopic("RL");
    store.ensureTopic("Bandits");
    expect(store.renameTopic(rl.id, "Reinforcement learning").aliases).toContain("RL");
    expect(store.ensureTopic("rl").id).toBe(rl.id);
    expect(() => store.renameTopic(rl.id, " bandits ")).toThrow(NameTakenError);
    expect(store.getTopic(rl.id).name).toBe("Reinforcement learning");
    expect(store.renameTopic(store.ensureNode("Bandits", "pet").id, "Bandit").name).toBe("Bandit");
  });

  it("moves a node to a new parent or the top level, and refuses a cycle keeping the old parent", () => {
    const { store } = tempStore();
    const [a, b, c] = ["A", "B", "C"].map((n) => store.ensureTopic(n));
    store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" });
    store.addEdge({ from: b!.id, to: c!.id, kind: "part_of", source: "placement" });
    expect(() => store.moveTopic(c!.id, a!.id)).toThrow(CycleError);
    expect(store.homeParent(c!.id)).toBeNull();
    const moved = store.moveTopic(a!.id, c!.id)!;
    expect([moved.from, moved.to, moved.source]).toEqual([a!.id, c!.id, "person"]);
    expect(store.moveTopic(a!.id, null)).toBeNull();
    expect(store.homeParent(a!.id)).toBeNull();
  });

  it("deletes an edge for good, and a node by moving its memories up to its parent", () => {
    const { store } = tempStore();
    const [a, b] = ["A", "B"].map((n) => store.ensureTopic(n));
    const e = store.addEdge({ from: a!.id, to: b!.id, kind: "part_of", source: "placement" })!;
    const m = seedMemory(store, "About A.", {}, [a!.id]);
    store.setHome(m.id, a!.id);
    store.deleteTopic(a!.id);
    expect(store.getMemory(m.id).homeNodeId).toBe(b!.id);
    expect(store.listTopics().map((t) => t.name)).toEqual(["B"]);
    const c = store.ensureTopic("C");
    const e2 = store.addEdge({ from: c.id, to: b!.id, kind: "requires", source: "expansion" })!;
    store.deleteEdge(e2.id);
    expect(store.addEdge({ from: c.id, to: b!.id, kind: "requires", source: "expansion" })).toBeNull();
    expect(() => store.deleteEdge("edg_000000000000")).toThrow(NotFoundError);
    expect(e.id).toBeTruthy();
  });

  it("moves memory homes in a merge", () => {
    const { store } = tempStore();
    const [rl, full] = ["RL", "reinforcement learning"].map((n) => store.ensureTopic(n));
    const m = seedMemory(store, "I know RL.", {}, [rl!.id]);
    store.setHome(m.id, rl!.id);
    store.mergeTopics(rl!.id, full!.id);
    expect(store.getMemory(m.id).homeNodeId).toBe(full!.id);
  });

  it("never renames, moves or deletes a root", () => {
    const { store } = tempStore();
    const life = store.root("life");
    expect(() => store.renameTopic(life.id, "Living")).toThrow(RootEditError);
    expect(() => store.moveTopic(life.id, store.root("work").id)).toThrow(RootEditError);
    expect(() => store.deleteTopic(life.id)).toThrow(RootEditError);
  });
});

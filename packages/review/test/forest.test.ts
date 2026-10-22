import { describe, expect, it } from "vitest";
import { served } from "./helpers.ts";

async function forestWorld() {
  const s = await served({
    setup: (w) => {
      const k = w.store.root("knowledge").id;
      const ml = w.store.ensureTopic("Machine learning");
      w.store.addEdge({ from: ml.id, to: k, kind: "part_of", source: "placement" });
      const rl = w.store.ensureTopic("RL");
      w.store.addEdge({ from: rl.id, to: ml.id, kind: "part_of", source: "placement" });
      const ppo = w.store.setTopic(w.store.ensureTopic("PPO").id, { frontier: true });
      w.store.addEdge({ from: ppo.id, to: rl.id, kind: "part_of", source: "expansion" });
      w.store.setTopic(ppo.id, { frontier: true });
      w.store.insertHypothesis({ nodeId: ml.id, depth: 2, rawScore: "medium", kind: "part", path: [rl.id, ml.id], reason: "RL is part of ML" });
      w.claim("RL", 3);
      const pets = w.store.ensureNode("Pets", "other");
      w.store.addEdge({ from: pets.id, to: w.store.root("life").id, kind: "part_of", source: "placement" });
      const o = w.store.addObservation({ sourceKind: "interview", sourceRef: "p", authorRole: "self", text: "cats", occurredAt: "2026-09-01T00:00:00.000Z" });
      const m = w.store.insertMemory({ kind: "fact", statement: "I have two cats.", tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction", homeNodeId: pets.id });
      w.store.approve(m.id);
    },
  });
  const id = (name: string) => s.w.store.listTopics().find((t) => t.name === name)!.id;
  return { ...s, id };
}

describe("the forest API", () => {
  it("lists the six roots, every node with its state, frontier flagged, and links", async () => {
    const { server, api, id } = await forestWorld();
    const f = (await api("/api/forest")).json!;
    expect(f.roots.map((r: { key: string }) => r.key)).toEqual(["knowledge", "work", "background", "people", "views", "life"]);
    const node = (name: string) => f.nodes.find((n: { name: string }) => n.name === name);
    expect(node("Machine learning")).toMatchObject({ state: "probable", p: 0.5, root: "knowledge" });
    expect(node("RL")).toMatchObject({ state: "lit", depth: 3 });
    expect(node("PPO")).toMatchObject({ frontier: true });
    expect(node("Pets")).toMatchObject({ state: "lit", facts: 1, root: "life" });
    expect(f.links).toEqual([]);
    expect(id("RL")).toBeTruthy();
    await server.finish();
  });

  it("shows a node's detail: facts, the guess's path and links", async () => {
    const { server, api, id } = await forestWorld();
    const d = (await api(`/api/node/${id("Machine learning")}`)).json!;
    expect(d.hypothesis).toMatchObject({ depth: 2, path: ["RL", "Machine learning"] });
    const pets = (await api(`/api/node/${id("Pets")}`)).json!;
    expect(pets.facts.map((f: { statement: string }) => f.statement)).toEqual(["I have two cats."]);
    expect((await api("/api/node/ent_000000000000")).status).toBe(404);
    await server.finish();
  });

  it("renames, moves, adds a child, refiles a fact, deletes an edge and a node", async () => {
    const { w, server, api, id } = await forestWorld();
    expect((await api("/api/tree/rename", { nodeId: id("RL"), name: "Reinforcement learning" })).status).toBe(200);
    expect((await api("/api/tree/add", { parentId: id("Pets"), name: "Miso", label: "pet" })).status).toBe(200);
    const miso = id("Miso");
    expect(w.store.homeParent(miso)).toBe(id("Pets"));
    const cats = w.store.nodeMemories(id("Pets"))[0]!;
    expect((await api("/api/fact/move", { memoryId: cats.id, nodeId: miso })).status).toBe(200);
    expect(w.store.getMemory(cats.id).homeNodeId).toBe(miso);
    expect((await api("/api/tree/move", { nodeId: id("Pets"), parentId: w.store.root("people").id })).status).toBe(200);
    expect(w.store.rootOf(miso)).toBe("people");
    const stats = w.store.ensureTopic("Statistics");
    const edge = w.store.addEdge({ from: id("Machine learning"), to: stats.id, kind: "related", source: "person" })!;
    expect((await api("/api/tree/delete-edge", { edgeId: edge.id })).status).toBe(200);
    expect(w.store.listEdges("related")).toEqual([]);
    expect((await api("/api/tree/delete-node", { nodeId: miso })).status).toBe(200);
    expect(w.store.getMemory(cats.id).homeNodeId).toBe(id("Pets"));
    await server.finish();
  });

  it("answers 409 with the reason for a cycle, a taken name or a root edit, and changes nothing", async () => {
    const { w, server, api, id } = await forestWorld();
    const cycle = await api("/api/tree/move", { nodeId: id("Machine learning"), parentId: id("RL") });
    expect(cycle.status).toBe(409);
    expect(cycle.json!.error).toContain("cycle");
    expect(w.store.homeParent(id("RL"))).toBe(id("Machine learning"));
    const taken = await api("/api/tree/rename", { nodeId: id("RL"), name: "machine learning" });
    expect([taken.status, taken.json!.error]).toEqual([409, "There is already a topic named machine learning."]);
    expect((await api("/api/tree/delete-node", { nodeId: w.store.root("life").id })).status).toBe(409);
    expect((await api("/api/tree/rename", { nodeId: id("RL"), name: "" })).status).toBe(400);
    await server.finish();
  });

  it("edits a node's definition and examples, and shows them in its detail", async () => {
    const { w, server, api, id } = await forestWorld();
    const res = await api("/api/tree/describe", { nodeId: id("RL"), definition: "Learning from rewards.", examples: [" Q-learning ", "PPO", "", "bandits"] });
    expect(res.status).toBe(200);
    const detail = (await api(`/api/node/${id("RL")}`)).json!;
    expect([detail.definition, detail.examples]).toEqual(["Learning from rewards.", ["Q-learning", "PPO", "bandits"]]);
    expect((await api("/api/tree/describe", { nodeId: w.store.root("knowledge").id, definition: "x", examples: [] })).status).toBe(409);
    await server.finish();
  });

  it("lists boundaries and undoes one", async () => {
    const { w, server, api, id } = await forestWorld();
    w.store.setTopic(id("RL"), { boundaryTier: 3 });
    expect((await api("/api/boundaries")).json!.boundaries).toEqual([{ nodeId: id("RL"), topic: "RL" }]);
    await api("/api/boundaries/undo", { nodeId: id("RL") });
    expect((await api("/api/boundaries")).json!.boundaries).toEqual([]);
    await server.finish();
  });
});

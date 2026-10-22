import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { loadSnapshot, renderForest, treeNodes } from "../src/index.ts";

function world() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-view-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const pets = store.ensureNode("Pets", "other");
  store.addEdge({ from: pets.id, to: store.root("life").id, kind: "part_of", source: "placement" });
  for (const statement of ["I have two cats.", "We hike most weekends."]) {
    const m = store.insertMemory({ kind: "fact", statement, tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [], actor: "compaction", homeNodeId: pets.id });
    store.approve(m.id);
  }
  const ml = store.ensureTopic("Machine learning");
  store.addEdge({ from: ml.id, to: store.root("knowledge").id, kind: "part_of", source: "placement" });
  const claim = store.insertMemory(
    { kind: "competence", statement: "I know ML well.", tier: 1, isCurrentState: false, attrs: { domain: "Machine learning", depth: 3 } },
    { sourceObservationIds: [o.id], entityIds: [ml.id], actor: "compaction", homeNodeId: ml.id },
  );
  store.approve(claim.id);
  const ppo = store.setTopic(store.ensureTopic("PPO").id, { frontier: true });
  store.addEdge({ from: ppo.id, to: ml.id, kind: "part_of", source: "expansion" });
  store.setTopic(ppo.id, { frontier: true });
  return { store, pets, ml, ppo };
}

describe("the forest view", () => {
  it("prints all six roots in order, with facts on life nodes and lighting on knowledge nodes", () => {
    const { store } = world();
    const text = renderForest(loadSnapshot(store));
    const roots = ["Knowledge", "Work", "Background", "People", "Views", "Life"].map((r) => text.indexOf(`${r}\n`));
    expect(roots.every((i) => i >= 0)).toBe(true);
    expect([...roots].sort((a, b) => a - b)).toEqual(roots);
    expect(text).toContain("  Pets  2 facts");
    expect(text).toContain("  Machine learning  lit 3 (claimed)");
    expect(text).not.toContain("PPO");
    expect(renderForest(loadSnapshot(store), { all: true })).toContain("    PPO  lit 3 (inherited from Machine learning) · frontier");
  });

  it("describes every node with its root, label, state and facts", () => {
    const { store, pets, ml, ppo } = world();
    const nodes = treeNodes(loadSnapshot(store), { all: true });
    expect(nodes.find((n) => n.id === pets.id)).toMatchObject({ root: "life", label: "other", state: "lit", facts: 2, parentId: store.root("life").id });
    expect(nodes.find((n) => n.id === ml.id)).toMatchObject({ root: "knowledge", state: "lit", depth: 3 });
    expect(nodes.find((n) => n.id === ppo.id)).toMatchObject({ frontier: true, parent: "Machine learning" });
    expect(treeNodes(loadSnapshot(store)).some((n) => n.id === ppo.id)).toBe(false);
  });
});

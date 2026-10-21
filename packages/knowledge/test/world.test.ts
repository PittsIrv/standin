import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import type { EntityKind } from "@standin/schema";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { computeLighting, expandNode, loadSnapshot, nextTarget, placeNodes, seedBackground, unplacedNodes } from "../src/index.ts";

function setup() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-world-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const approve = (kind: "fact" | "competence", statement: string, attrs: object, nodes: [string, EntityKind][] = []) => {
    const m = store.insertMemory({ kind, statement, tier: 1, isCurrentState: false, attrs } as never, {
      sourceObservationIds: [o.id],
      entityIds: nodes.map(([n, label]) => store.ensureNode(n, label).id),
      actor: "compaction",
    });
    store.approve(m.id);
    return m;
  };
  return { store, approve };
}

describe("the world tree in the knowledge layer", () => {
  it("places a pet under Life, creating the parent the model names", async () => {
    const { store, approve } = setup();
    approve("fact", "Miso is my cat.", {}, [["Miso", "pet"]]);
    expect(unplacedNodes(store).map((n) => n.name)).toEqual(["Miso"]);
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.prompt).toContain("Life");
      expect(req.prompt).toContain("Miso [pet]");
      return {
        merges: [],
        placements: [{ topic: "Miso", parent: "Pets", parentDefinition: "Animals I live with.", parentLabel: "other", root: "life", definition: "My cat." }],
      };
    });
    const report = await placeNodes(store, llm, "Lin Qiao");
    expect(report.placed).toBe(1);
    const miso = store.ensureNode("Miso", "pet");
    expect(store.getTopic(store.homeParent(miso.id)!).name).toBe("Pets");
    expect(store.rootOf(miso.id)).toBe("life");
    expect(unplacedNodes(store)).toEqual([]);
  });

  it("lights only Knowledge: a competence memory homed in Life lights nothing, and probing never targets it", () => {
    const { store, approve } = setup();
    const go = store.ensureNode("Go (the game)", "other");
    store.addEdge({ from: go.id, to: store.root("life").id, kind: "part_of", source: "placement" });
    approve("competence", "I play Go well.", { domain: "Go (the game)", depth: 3 }, [["Go (the game)", "other"]]);
    approve("competence", "I know Rust well.", { domain: "Rust", depth: 3 }, [["Rust", "topic"]]);
    const t = loadSnapshot(store);
    expect(t.rootOf.get(go.id)).toBe("life");
    expect(t.knowledge.has(go.id)).toBe(false);
    const lit = computeLighting(t);
    expect(lit.has(go.id)).toBe(false);
    expect(lit.get(store.ensureTopic("Rust").id)?.depth).toBe(3);
    const target = nextTarget(t, { responses: [], children: new Map() }, new Set());
    expect(typeof target === "string" ? target : target?.nodeId).not.toContain(go.id);
  });

  it("marks only components that expansion created as frontier", async () => {
    const { store } = setup();
    const rl = store.ensureTopic("RL");
    const existing = store.ensureTopic("Bandits");
    const llm = new ScriptedLLM(() => ({
      components: ["Bandits", "PPO", "Q-learning"].map((name, i) => ({ name, definition: ".", level: i + 1 })),
      prerequisites: [],
    }));
    await expandNode(store, llm, rl.id, "Lin Qiao");
    expect(store.ensureTopic("PPO").frontier).toBe(true);
    expect(store.getTopic(existing.id).frontier).toBe(false);
  });

  it("seeds the field under the Knowledge root", async () => {
    const { store, approve } = setup();
    approve("fact", "I'm a CS student.", { background: true });
    const llm = new ScriptedLLM(() => ({ field: { name: "Computer science", definition: "." }, core: [{ name: "Algorithms", definition: "." }] }));
    await seedBackground(store, llm, "Lin Qiao");
    expect(store.homeParent(store.ensureTopic("Computer science").id)).toBe(store.root("knowledge").id);
    expect(store.rootOf(store.ensureTopic("Algorithms").id)).toBe("knowledge");
  });
});

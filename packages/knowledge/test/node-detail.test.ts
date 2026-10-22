import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { loadSnapshot, nodeDetail } from "../src/index.ts";

describe("nodeDetail", () => {
  it("gathers a node's facts, guess with its path, probe history and links", () => {
    const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-detail-")), "db") });
    const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
    const ml = store.ensureTopic("Machine learning", "Learning from data.");
    const rl = store.ensureTopic("RL");
    store.addEdge({ from: ml.id, to: store.root("knowledge").id, kind: "part_of", source: "placement" });
    store.addEdge({ from: rl.id, to: ml.id, kind: "part_of", source: "placement" });
    const stats = store.ensureTopic("Statistics");
    store.addEdge({ from: ml.id, to: stats.id, kind: "related", source: "person" });
    const fact = store.insertMemory({ kind: "fact", statement: "I took an ML course.", tier: 1, isCurrentState: false, attrs: {} }, { sourceObservationIds: [o.id], entityIds: [ml.id], actor: "compaction", homeNodeId: ml.id });
    store.approve(fact.id);
    const claim = store.insertMemory({ kind: "competence", statement: "I know RL.", tier: 1, isCurrentState: false, attrs: { domain: "RL", depth: 3 } }, { sourceObservationIds: [o.id], entityIds: [rl.id], actor: "compaction" });
    store.approve(claim.id);
    store.insertHypothesis({ nodeId: ml.id, depth: 2, rawScore: "medium", kind: "part", path: [rl.id, ml.id], reason: "RL is part of ML" });
    const session = store.startSession(5);
    const p = store.insertProbe({ nodeId: ml.id, checkOf: null, kind: "hypothesis", difficulty: 2, question: "What is overfitting?", holdout: "none" });
    store.rateResponse(store.showProbe(p.id, session.id, "decline").id, "roughly", false);

    const d = nodeDetail(store, loadSnapshot(store), ml.id);
    expect(d).toMatchObject({ definition: "Learning from data.", node: { name: "Machine learning", state: "probable" } });
    expect(d.facts).toEqual([{ id: fact.id, kind: "fact", statement: "I took an ML course.", tier: 1 }]);
    expect(d.hypothesis).toMatchObject({ depth: 2, kind: "part", path: ["RL", "Machine learning"] });
    expect(d.history).toEqual([expect.objectContaining({ question: "What is overfitting?", rating: "roughly", kind: "hypothesis", difficulty: 2 })]);
    expect(d.links).toEqual([expect.objectContaining({ kind: "related", other: { id: stats.id, name: "Statistics" } })]);
  });
});

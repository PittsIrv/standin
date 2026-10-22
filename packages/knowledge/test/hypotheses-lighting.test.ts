import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM } from "@standin/llm";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { answerMode, computeLighting, loadSnapshot, nodeStatus, seedBackground, treeNodes } from "../src/index.ts";

function world() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-hl-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const approve = (kind: "fact" | "competence", statement: string, attrs: object, topics: string[] = []) => {
    const m = store.insertMemory({ kind, statement, tier: 1, isCurrentState: false, attrs } as never, {
      sourceObservationIds: [o.id],
      entityIds: topics.map((t) => store.ensureTopic(t).id),
      actor: "compaction",
    });
    return store.approve(m.id);
  };
  const session = store.startSession(20);
  const answer = (hypothesisId: string, nodeId: string, depth: number, rating: "know" | "no_idea", grade?: "pass" | "fail") => {
    const p = store.insertProbe({ nodeId, checkOf: null, kind: "hypothesis", difficulty: depth, question: `Q ${Math.random()}?`, holdout: "none", hypothesisId });
    const r = store.showProbe(p.id, session.id, "decline");
    store.rateResponse(r.id, rating, grade !== undefined);
    return r;
  };
  return { store, approve, answer };
}

const seed = (field: string, core: string[]) => ({
  concepts: [field, ...core].map((name, i) => ({ name, definition: `${name}.`, depth: 2, partOf: i === 0 ? null : field, evidence: [{ fact: 1, type: "degree" }] })),
});
const SEED = seed("Computer science", ["Algorithms", "Systems"]);

describe("hypotheses in the tree", () => {
  it("turns a background into probable nodes at 2, not lit ones", async () => {
    const { store, approve } = world();
    approve("fact", "I'm a CS student at CMU.", { background: true });
    await seedBackground(store, new ScriptedLLM(() => SEED), "Lin Qiao");
    await seedBackground(store, new ScriptedLLM(() => SEED), "Lin Qiao");
    expect(store.listHypotheses().map((h) => [store.getTopic(h.nodeId).name, h.depth, h.kind, h.path.length]).sort()).toEqual([
      ["Algorithms", 2, "degree", 2],
      ["Computer science", 2, "degree", 1],
      ["Systems", 2, "degree", 2],
    ]);
    const t = loadSnapshot(store);
    const algorithms = store.ensureTopic("Algorithms").id;
    expect(computeLighting(t).has(algorithms)).toBe(false);
    expect(t.hypotheses.get(algorithms)).toMatchObject({ depth: 2, p: 0.5, kind: "degree" });
    const node = treeNodes(t).find((n) => n.id === algorithms)!;
    expect(node).toMatchObject({ state: "probable", p: 0.5 });
    expect(nodeStatus(node)).toBe("probable 2 (p 0.50, degree)");
  });

  it("lights a confirmed hypothesis as probed, and unlights it when a later spot-check fails", () => {
    const { store, answer } = world();
    const n = store.ensureTopic("Algorithms");
    const h = store.insertHypothesis({ nodeId: n.id, depth: 2, rawScore: "medium", kind: "background", path: [n.id], reason: "r" });
    const r = answer(h.id, n.id, 2, "know", "pass");
    let t = loadSnapshot(store);
    expect(computeLighting(t).get(n.id)).toMatchObject({ depth: 2, basis: "probed" });
    expect(nodeStatus(treeNodes(t).find((x) => x.id === n.id)!)).toBe("lit 2 (probed)");
    store.recordGrade(r.id, "fail", "wrong");
    t = loadSnapshot(store);
    expect(computeLighting(t).has(n.id)).toBe(false);
  });

  it("speaks a probable node hedged only at or above the speaking threshold", () => {
    const { store } = world();
    const n = store.ensureTopic("Algorithms");
    store.insertHypothesis({ nodeId: n.id, depth: 3, rawScore: "high", kind: "part", path: [n.id], reason: "r" });
    store.setKv("priors", JSON.stringify({ "part:high": { a: 9, b: 1 } }));
    expect(answerMode(loadSnapshot(store), n.id)).toMatchObject({ mode: "brief", depth: 3, from: { nodeId: n.id, via: "hypothesis" } });
    store.setKv("priors", JSON.stringify({ "part:high": { a: 6, b: 4 } }));
    expect(answerMode(loadSnapshot(store), n.id)).toMatchObject({ mode: "decline" });
    expect(answerMode(loadSnapshot(store), n.id, { speakAt: 0.5 })).toMatchObject({ mode: "brief" });
  });

  it("lets the person's own claim override a hypothesis", () => {
    const { store, approve } = world();
    const n = store.ensureTopic("Algorithms");
    store.insertHypothesis({ nodeId: n.id, depth: 2, rawScore: "high", kind: "part", path: [n.id], reason: "r" });
    approve("competence", "I know algorithms well.", { domain: "Algorithms", depth: 4 }, ["Algorithms"]);
    expect(answerMode(loadSnapshot(store), n.id)).toMatchObject({ mode: "explain", depth: 4, from: { via: "own" } });
  });
});

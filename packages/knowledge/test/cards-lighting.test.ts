import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { answerMode, cardScores, computeLighting, loadSnapshot, nodeStatus, outcomeOf, treeNodes } from "../src/index.ts";

function world() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-cl-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const session = store.startSession(1);
  const k = store.root("knowledge").id;
  const node = (name: string, parent = k) => {
    const n = store.ensureTopic(name);
    store.addEdge({ from: n.id, to: parent, kind: "part_of", source: "placement" });
    return n;
  };
  const claim = (name: string, depth: number) => {
    const m = store.insertMemory({ kind: "competence", statement: `I know ${name}.`, tier: 1, isCurrentState: false, attrs: { domain: name, depth } }, { sourceObservationIds: [o.id], entityIds: [store.ensureTopic(name).id], actor: "compaction" });
    store.approve(m.id);
  };
  const say = (nodeId: string, answer: number | "wouldnt_say", o2: { hypothesisId?: string; mode?: "explain" | "brief" | "decline"; p?: [number, number] } = {}) => {
    const p = store.insertProbe({ nodeId, checkOf: null, kind: "card", difficulty: 1, question: "def", holdout: "none", hypothesisId: o2.hypothesisId ?? null });
    const r = store.showProbe(p.id, session.id, o2.mode ?? "decline", o2.p ? { predictedP: o2.p[0], priorP: o2.p[1] } : undefined);
    return store.answerCard(r.id, answer);
  };
  return { store, node, claim, say };
}

describe("card answers in the tree", () => {
  it("lights the branch at the stated level, beating what a claimed parent passes down", () => {
    const { store, node, claim, say } = world();
    const rl = node("RL");
    const ppo = node("PPO", rl.id);
    const sub = node("PPO clipping", ppo.id);
    claim("RL", 4);
    say(ppo.id, 2);
    const t = loadSnapshot(store);
    expect(computeLighting(t).get(ppo.id)).toMatchObject({ depth: 2, basis: "stated" });
    expect(answerMode(t, sub.id)).toMatchObject({ depth: 2, from: { nodeId: ppo.id, via: "inherited" } });
    expect(nodeStatus(treeNodes(t).find((n) => n.id === ppo.id)!)).toBe("lit 2 (you said)");
  });

  it("darkens a branch the person said No to", () => {
    const { store, node, say } = world();
    const graphics = node("Graphics");
    say(graphics.id, 0);
    const t = loadSnapshot(store);
    expect(answerMode(t, graphics.id)).toMatchObject({ mode: "decline", depth: 0 });
    expect(nodeStatus(treeNodes(t).find((n) => n.id === graphics.id)!)).toBe("dark (you said so)");
  });

  it("settles a guess from one card: at or above its depth confirms, below refutes", () => {
    const { store, node, say } = world();
    const a = node("Algorithms");
    const b = node("Systems");
    const ha = store.insertHypothesis({ nodeId: a.id, depth: 2, rawScore: "medium", kind: "background", path: [a.id], reason: "r" });
    const hb = store.insertHypothesis({ nodeId: b.id, depth: 3, rawScore: "medium", kind: "background", path: [b.id], reason: "r" });
    say(a.id, 3, { hypothesisId: ha.id });
    say(b.id, 2, { hypothesisId: hb.id });
    const rs = store.listResponses({ rated: true });
    expect(outcomeOf(ha, rs)).toBe("confirmed");
    expect(outcomeOf(hb, rs)).toBe("refuted");
  });

  it("scores every answer against the prediction made before it", () => {
    const { store, node, say } = world();
    const g = store.insertHypothesis({ nodeId: node("A").id, depth: 2, rawScore: "medium", kind: "part", path: [node("A").id], reason: "r" });
    say(node("A").id, 3, { mode: "brief", hypothesisId: g.id, p: [0.9, 0.5] });
    say(node("B").id, 0, { mode: "brief" });
    say(node("C").id, 1, { mode: "decline" });
    say(node("D").id, "wouldnt_say", { mode: "explain" });
    const s = cardScores(store);
    expect(s.map).toEqual({ n: 3, agree: 2, score: 2 / 3 });
    expect(s.guesses).toMatchObject({ n: 1, tripped: false });
    expect(s.guesses.calibrated).toBeCloseTo(0.01);
  });

  it("still reads an instance with old quiz answers", () => {
    const { store, node } = world();
    const n = node("Old");
    const p = store.insertProbe({ nodeId: n.id, checkOf: null, kind: "foundation", difficulty: 2, question: "q?", holdout: "fixed" });
    store.rateResponse(store.showProbe(p.id, store.listSessions()[0]!.id, "brief").id, "know", false);
    expect(() => loadSnapshot(store)).not.toThrow();
    expect(cardScores(store).map.n).toBe(0);
  });
});

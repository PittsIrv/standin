import { describe, expect, it } from "vitest";
import { tempStore } from "./helpers.ts";

describe("hypotheses", () => {
  it("round-trips, lists by status and node, settles and withdraws", () => {
    const { store } = tempStore();
    const [a, b] = ["Algorithms", "Systems"].map((n) => store.ensureTopic(n));
    const h = store.insertHypothesis({ nodeId: a!.id, depth: 2, rawScore: "medium", kind: "background", path: [a!.id], reason: "core of CS" });
    const g = store.insertHypothesis({ nodeId: b!.id, depth: 3, rawScore: "high", kind: "part", path: [a!.id, b!.id], reason: "r" });
    expect(h).toMatchObject({ status: "open", settledAt: null, path: [a!.id] });
    expect(store.listHypotheses({ nodeId: b!.id }).map((x) => x.id)).toEqual([g.id]);
    expect(store.settleHypothesis(h.id).status).toBe("settled");
    expect(store.withdrawHypothesis(g.id).status).toBe("withdrawn");
    expect(store.listHypotheses({ status: "open" })).toEqual([]);
    expect(store.getHypothesis(h.id).settledAt).not.toBeNull();
  });

  it("keeps small key-value settings", () => {
    const { store } = tempStore();
    expect(store.getKv("x")).toBeNull();
    store.setKv("x", "1");
    store.setKv("x", "2");
    expect(store.getKv("x")).toBe("2");
  });

  it("links probes to hypotheses and stores the predicted probability when shown", () => {
    const { store } = tempStore();
    const n = store.ensureTopic("Algorithms");
    const h = store.insertHypothesis({ nodeId: n.id, depth: 2, rawScore: "medium", kind: "background", path: [n.id], reason: "r" });
    const p = store.insertProbe({ nodeId: n.id, checkOf: null, kind: "hypothesis", difficulty: 2, question: "Q?", holdout: "none", hypothesisId: h.id });
    expect(p.hypothesisId).toBe(h.id);
    const session = store.startSession(5);
    const r = store.showProbe(p.id, session.id, "decline", { predictedP: 0.62, priorP: 0.5 });
    expect([r.predictedP, r.priorP]).toEqual([0.62, 0.5]);
  });
});

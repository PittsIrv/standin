import { describe, expect, it } from "vitest";
import { AlreadyRatedError } from "../src/index.ts";
import { tempStore } from "./helpers.ts";

function setup() {
  const { store, clock } = tempStore();
  const node = store.ensureTopic("consensus");
  const session = store.startSession(10);
  const probe = (holdout: "none" | "fixed" | "rotating" = "none") =>
    store.insertProbe({ nodeId: node.id, checkOf: null, kind: "foundation", difficulty: 2, question: "How does Raft elect a leader?", holdout });
  return { store, clock, node, session, probe };
}

describe("probes and responses", () => {
  it("shows a probe once, with the prediction recorded first", () => {
    const { store, session, probe } = setup();
    const p = probe();
    const r = store.showProbe(p.id, session.id, "brief");
    expect(r).toMatchObject({ probeId: p.id, sessionId: session.id, predictedMode: "brief", rating: null, spotCheck: "none" });
    expect(() => store.showProbe(p.id, session.id, "brief")).toThrow(/already shown/);
  });

  it("refuses a second rating of the same response", () => {
    const { store, session, probe } = setup();
    const r = store.showProbe(probe().id, session.id, "brief");
    expect(store.rateResponse(r.id, "know", true)).toMatchObject({ rating: "know", spotCheck: "requested" });
    expect(() => store.rateResponse(r.id, "no_idea", false)).toThrow(AlreadyRatedError);
    expect(store.listResponses({ sessionId: session.id })[0]!.rating).toBe("know");
  });

  it("records spot-check answers, grades, batches and judgments", () => {
    const { store, session, probe } = setup();
    const r = store.showProbe(probe().id, session.id, "brief");
    store.rateResponse(r.id, "know", true);
    const o = store.addObservation({ sourceKind: "probe", sourceRef: "probe:x", authorRole: "self", text: "Q: q\n\nA: a", occurredAt: "2026-10-01T00:00:00.000Z" });
    store.answerSpotCheck(r.id, "By randomized timeouts and votes.", o.id);
    expect(store.listResponses({ ungraded: true }).map((x) => x.id)).toEqual([r.id]);
    store.setGradeBatch([r.id], "batch_1");
    expect(store.listResponses()[0]!.gradeBatchId).toBe("batch_1");
    store.recordGrade(r.id, "fail", "Missed the term limit.");
    expect(store.listResponses({ ungraded: true })).toEqual([]);
    expect(store.judgeResponse(r.id, "gap").judged).toBe("gap");
  });

  it("releases only rotating probes rated in the given sessions", () => {
    const { store, session, probe } = setup();
    const kinds = ["none", "fixed", "rotating"] as const;
    for (const h of kinds) store.rateResponse(store.showProbe(probe(h).id, session.id, "brief").id, "know", false);
    const other = store.startSession(10);
    store.showProbe(probe("rotating").id, other.id, "brief"); // shown, never rated
    expect(store.releaseRotating([session.id, other.id]).map((p) => p.holdout)).toEqual(["rotating"]);
    expect(store.listProbes().filter((p) => p.releasedAt !== null)).toHaveLength(1);
  });

  it("tracks sessions", () => {
    const { store, session } = setup();
    expect(store.listSessions().map((s) => [s.id, s.endedAt])).toEqual([[session.id, null]]);
    expect(store.endSession(session.id).endedAt).not.toBeNull();
  });

  it("moves probes with a merge, and updates gaps", () => {
    const { store, node, probe } = setup();
    const p = probe();
    const raft = store.ensureTopic("Raft consensus");
    store.mergeTopics(node.id, raft.id);
    expect(store.listProbes().map((x) => x.nodeId)).toEqual([raft.id]);
    expect(p.nodeId).toBe(node.id);
    const g = store.addGap({ nodeId: raft.id, claimNodeId: null, level: 2, status: "open", source: "probe", memoryId: null })!;
    expect(store.setGap(g.id, { status: "kept" }).status).toBe("kept");
  });
});

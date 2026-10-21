import type { Probe, ProbeKind, ProbeResponse, Rating } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { nextTarget, type ProbeState } from "../src/index.ts";
import { tree } from "./fixtures.ts";

let n = 0;
function resp(
  kind: ProbeKind,
  nodeId: string,
  difficulty: number,
  rating: Rating | null,
  extra: { checkOf?: string; judged?: "gap" | "not_gap"; hypothesisId?: string; holdout?: "none" | "fixed" | "rotating" } = {},
) {
  n++;
  const probe: Probe = { id: `prb_${n}`, nodeId, checkOf: extra.checkOf ?? null, kind, difficulty, question: "q?", holdout: extra.holdout ?? "none", createdAt: "2026-10-01T00:00:00.000Z", releasedAt: null, hypothesisId: extra.hypothesisId ?? null };
  const r: ProbeResponse = {
    id: `rsp_${n}`, probeId: probe.id, sessionId: "ses_1", shownAt: `2026-10-01T00:00:${String(n).padStart(2, "0")}.000Z`, predictedMode: "brief",
    rating, answeredAt: null, spotCheck: "none", spotCheckAnswer: null, observationId: null, grade: null, gradeReason: null, gradeBatchId: null, judged: extra.judged ?? null,
    predictedP: null, priorP: null, level: null,
  };
  return { ...r, probe };
}

function state(t: ReturnType<typeof tree>, responses: ReturnType<typeof resp>[] = []): ProbeState {
  const children = new Map<string, string[]>();
  for (const [c, p] of t.parentOf) children.set(p, [...(children.get(p) ?? []), c]);
  return { responses, children };
}

const expanded = (t: ReturnType<typeof tree>, ...ids: string[]) => {
  for (const id of ids) t.topics.set(id, { ...t.topics.get(id)!, expandedAt: "2026-10-01T00:00:00.000Z" });
  return t;
};

describe("nextTarget", () => {
  const ds = () =>
    expanded(
      tree({ partOf: [["consensus", "DS"], ["replication", "DS"], ["partitioning", "DS"], ["fault tolerance", "DS"]], claims: { DS: 3 } }),
      "DS",
    );

  it("checks a claim with 3 probes on different parts, at the claimed depth", () => {
    const t = ds();
    expect(nextTarget(t, state(t), new Set())).toEqual({ kind: "claim", nodeId: "consensus", difficulty: 3, checkOf: "DS" });
    const done = [resp("claim", "consensus", 3, "know", { checkOf: "DS" }), resp("claim", "fault tolerance", 3, "know", { checkOf: "DS" })];
    expect(nextTarget(t, state(t, done), new Set())).toMatchObject({ kind: "claim", nodeId: "partitioning" });
    done.push(resp("claim", "partitioning", 3, "roughly", { checkOf: "DS" }));
    expect(nextTarget(t, state(t, done), new Set())).toBeNull();
  });

  it("asks to expand an unexpanded claimed node, and skips claims at 0", () => {
    const t = tree({ claims: { Rust: 3, knitting: 0 } });
    expect(nextTarget(t, state(t), new Set())).toBe("expand:Rust");
  });

  it("puts a pending follow-up before claims, one level lower", () => {
    const t = ds();
    const missed = resp("claim", "consensus", 3, "no_idea", { checkOf: "DS", judged: "gap" });
    expect(nextTarget(t, state(t, [missed]), new Set())).toEqual({ kind: "followup", nodeId: "consensus", difficulty: 2, checkOf: "DS", gapOf: missed.id });
    const followed = [missed, resp("followup", "consensus", 2, "know", { checkOf: "DS" })];
    expect(nextTarget(t, state(t, followed), new Set())).toMatchObject({ kind: "claim", nodeId: "fault tolerance" });
  });

  it("probes open hypotheses after claims, most uncertain first, once each", () => {
    const t = tree({ hypotheses: { Algorithms: { depth: 2, p: 0.9 }, Systems: { depth: 2, p: 0.55 } } });
    expect(nextTarget(t, state(t), new Set())).toEqual({ kind: "hypothesis", nodeId: "Systems", difficulty: 2, hypothesisId: "hyp_Systems" });
    const asked = [resp("hypothesis", "Systems", 2, "know", { hypothesisId: "hyp_Systems" })];
    expect(nextTarget(t, state(t, asked), new Set())).toMatchObject({ kind: "hypothesis", nodeId: "Algorithms" });
    asked.push(resp("hypothesis", "Algorithms", 2, "no_idea", { hypothesisId: "hyp_Algorithms" }));
    expect(nextTarget(t, state(t, asked), new Set())).toBeNull();
    // Claims still come first.
    const withClaim = expanded(tree({ partOf: [["a", "R"], ["b", "R"], ["c", "R"]], claims: { R: 2 }, hypotheses: { Systems: { depth: 2, p: 0.5 } } }), "R");
    expect(nextTarget(withClaim, state(withClaim), new Set())).toMatchObject({ kind: "claim" });
  });

  it("asks a hypothesis at 4 twice unless the first answer refutes it, and re-asks after a fixed held-out probe", () => {
    const t = tree({ hypotheses: { Paxos: { depth: 4, p: 0.5 } } });
    const one = [resp("hypothesis", "Paxos", 4, "know", { hypothesisId: "hyp_Paxos" })];
    expect(nextTarget(t, state(t, one), new Set())).toEqual({ kind: "hypothesis", nodeId: "Paxos", difficulty: 4, hypothesisId: "hyp_Paxos" });
    one.push(resp("hypothesis", "Paxos", 4, "know", { hypothesisId: "hyp_Paxos" }));
    expect(nextTarget(t, state(t, one), new Set())).toBeNull();
    expect(nextTarget(t, state(t, [resp("hypothesis", "Paxos", 4, "no_idea", { hypothesisId: "hyp_Paxos" })]), new Set())).toBeNull();
    const held = [resp("hypothesis", "Algorithms", 2, "know", { hypothesisId: "hyp_Algorithms", holdout: "fixed" })];
    const t2 = tree({ hypotheses: { Algorithms: { depth: 2, p: 0.5 } } });
    expect(nextTarget(t2, state(t2, held), new Set())).toMatchObject({ kind: "hypothesis", nodeId: "Algorithms" });
  });

  it("skips kept branches, deleted nodes and targets it was told to skip", () => {
    const t = ds();
    t.gaps.push({ id: "g", nodeId: "consensus", claimNodeId: "DS", level: 2, status: "kept", source: "probe", memoryId: null, responseId: null, createdAt: "2026-10-01T00:00:00.000Z" });
    expect(nextTarget(t, state(t), new Set())).toBeNull();
    const t2 = ds();
    t2.topics.delete("consensus");
    t2.parentOf.delete("consensus");
    expect(nextTarget(t2, state(t2), new Set(["claim:replication"]))).toMatchObject({ kind: "claim", nodeId: "fault tolerance" });
  });
});

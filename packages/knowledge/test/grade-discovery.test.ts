import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { describe, expect, it } from "vitest";
import { collectGrades, computeLighting, discoveryProposals, loadSnapshot, submitGrades } from "../src/index.ts";
import { tree } from "./fixtures.ts";
import { queued, topicId, world } from "./session-helpers.ts";

/** A session where every probe is spot-checked and answered with `answer(probeIndex)`. */
async function spotChecked(w: ReturnType<typeof world>, answer: (i: number) => string) {
  const s = await w.start();
  let i = 0;
  for (let p = await s.next(); p; p = await s.next(), i++) {
    s.rate(p.responseId, "know");
    s.answer(p.responseId, answer(i));
  }
  return s;
}

describe("grading", () => {
  const grader = (opts: { batchPolls?: number; failOn?: string } = {}) =>
    new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      if (opts.failOn && req.prompt.includes(opts.failOn)) throw new Error("grader hiccup");
      return { grade: "pass", reason: "ok" };
    }, opts);

  it("grades through a batch: submit, wait, collect, and resubmit failures", async () => {
    const w = world({ size: 2, rng: queued([0.5, 0.0, 0.5, 0.0]) });
    w.claim("Rust", 3);
    await (await spotChecked(w, (i) => (i === 0 ? "Ownership moves values between owners." : "Borrowing lends without moving."))).finish();
    w.store.listResponses().forEach((r) => w.store.setGradeBatch([r.id], null)); // undo the session's own grading
    const g = grader({ batchPolls: 1, failOn: "Borrowing" });
    expect(await submitGrades(w.store, g, "Lin Qiao")).toEqual({ submitted: 2, gradedLive: 0 });
    expect(w.store.listResponses().every((r) => r.gradeBatchId !== null)).toBe(true);
    expect(await collectGrades(w.store, g)).toEqual({ collected: 0, failedResubmit: 0 });
    expect(await collectGrades(w.store, g)).toEqual({ collected: 1, failedResubmit: 1 });
    const failed = w.store.listResponses({ ungraded: true });
    expect(failed.map((r) => r.gradeBatchId)).toEqual([null]);
    expect((await submitGrades(w.store, grader(), "Lin Qiao")).submitted).toBe(1);
  });

  it("grades live when the provider has no batch API", async () => {
    const w = world({ size: 1, rng: queued([0.5, 0.0]) });
    w.claim("Rust", 3);
    await spotChecked(w, () => "Ownership moves values between owners.");
    const live = { generateObject: async () => ({ grade: "fail" as const, reason: "wrong" }) };
    expect(await submitGrades(w.store, live as never, "Lin Qiao")).toEqual({ submitted: 0, gradedLive: 1 });
    expect(w.store.listResponses()[0]!.grade).toBe("fail");
  });
});

describe("foundations", () => {
  it("confirms an inferred node on a usable 'know'", async () => {
    const w = world({ size: 1 });
    const node = w.store.ensureTopic("Algorithms");
    const lit = w.store.insertMemory(
      { kind: "competence", statement: "x", tier: 1, isCurrentState: false, attrs: { domain: "Algorithms", depth: 2, basis: "predicted", reasons: [] } },
      { sourceObservationIds: [], entityIds: [node.id], actor: "map" },
    );
    w.store.approve(lit.id);
    const s = await w.start();
    const p = (await s.next())!;
    expect(p.kind).toBe("foundation");
    s.rate(p.responseId, "know");
    expect(loadSnapshot(w.store).confirmed.has(node.id)).toBe(true);
  });
});

describe("discovery", () => {
  /** Raft lit at 3 under a dark parent: its sibling Paxos is discovered. */
  function discoverable(rng: () => number) {
    const w = world({ rng });
    const consensus = w.store.ensureTopic("consensus");
    const raft = w.store.ensureTopic("Raft");
    const paxos = w.store.ensureTopic("Paxos");
    w.store.addEdge({ from: raft.id, to: consensus.id, kind: "part_of", source: "placement" });
    w.store.addEdge({ from: paxos.id, to: consensus.id, kind: "part_of", source: "placement" });
    w.store.setTopic(raft.id, { expandedAt: w.store.nowIso() });
    const lit = w.store.insertMemory(
      { kind: "competence", statement: "x", tier: 1, isCurrentState: false, attrs: { domain: "Raft", depth: 3, basis: "probed", reasons: [] } },
      { sourceObservationIds: [], entityIds: [raft.id], actor: "person" },
    );
    w.store.approve(lit.id);
    return { w, paxos };
  }

  it("walks up to 4, asks twice there with spot-checks, and proposes 3 until the grades pass", async () => {
    const { w, paxos } = discoverable(queued());
    const s = await w.start();
    const walk: number[] = [];
    for (let p = await s.next(); p; p = await s.next()) {
      walk.push(p.difficulty);
      const { spotCheck } = s.rate(p.responseId, "know");
      if (p.difficulty === 4) {
        expect(spotCheck).toBe(true);
        s.answer(p.responseId, `Paxos uses proposers, acceptors and majorities, round ${walk.length}.`);
      }
    }
    expect(walk).toEqual([2, 3, 4, 4]);
    const report = await s.finish();
    expect(report.discoveryProposals).toBe(1);
    const proposed = () => w.store.topicMemories(paxos.id, { kind: "competence", status: "proposed" });
    expect(proposed().map((m) => m.kind === "competence" && m.attrs.depth)).toEqual([3]);
    await w.start(); // collects the passing grades, and upgrades the proposal
    expect(proposed().map((m) => m.kind === "competence" && m.attrs.depth)).toEqual([4]);
  });

  it("never re-proposes a rejected discovery", async () => {
    const { w, paxos } = discoverable(queued());
    const s = await w.start();
    for (let p = await s.next(); p; p = await s.next()) s.rate(p.responseId, p.difficulty < 3 ? "know" : "no_idea");
    await s.finish();
    const [m] = w.store.topicMemories(paxos.id, { kind: "competence", status: "proposed" });
    expect(m!.kind === "competence" && m!.attrs).toMatchObject({ depth: 2, basis: "probed" });
    w.store.reject(m!.id);
    expect(discoveryProposals(w.store, loadSnapshot(w.store))).toEqual([]);
    expect(topicId(w.store, "Paxos")).toBe(paxos.id);
  });
});

describe("precedence", () => {
  it("never raises probed lighting by inference", () => {
    const t = tree({ partOf: [["RLHF", "ML"]], claims: { RLHF: 4 }, approved: { ML: { depth: 1, basis: "probed" } } });
    expect(computeLighting(t).get("ML")).toMatchObject({ depth: 1, basis: "probed" });
  });
});

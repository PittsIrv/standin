import { describe, expect, it } from "vitest";
import { answerMode, loadSnapshot, ProbeSession } from "../src/index.ts";
import { queued, topicId, world } from "./session-helpers.ts";

/** Runs a session, rating each probe with `rate(topic, kind, difficulty)`. */
async function runSession(s: ProbeSession, rate: (p: { topic: string; kind: string; difficulty: number }) => "know" | "roughly" | "no_idea") {
  for (let p = await s.next(); p; p = await s.next()) s.rate(p.responseId, rate(p));
}

describe("misses and gaps", () => {
  it("turns a confirmed miss into a gap, follows up one level lower, then keeps the claim", async () => {
    const w = world();
    w.claim("Rust", 3);
    const s = await w.start();
    await runSession(s, (p) => (p.topic === "Rust four" ? "no_idea" : "know"));
    const [miss] = s.pendingMisses();
    expect(miss).toMatchObject({ topic: "Rust four", difficulty: 3, reason: "no_idea" });
    s.judgeMiss(miss!.responseId, true);
    const follow = (await s.next())!;
    expect(follow).toMatchObject({ kind: "followup", topic: "Rust four", difficulty: 2 });
    s.rate(follow.responseId, "know");
    expect(s.pendingClaimDecisions()).toEqual([{ claimNodeId: topicId(w.store, "Rust"), topic: "Rust", claimed: 3, gaps: [{ topic: "Rust four", level: 2 }] }]);
    s.decideClaim(topicId(w.store, "Rust"), "keep");
    expect(s.pendingClaimDecisions()).toEqual([]);
    const t = loadSnapshot(w.store);
    expect(answerMode(t, topicId(w.store, "Rust four"))).toMatchObject({ mode: "brief", depth: 2, from: { via: "gap" } });
    expect(answerMode(t, topicId(w.store, "Rust one")).mode).toBe("explain");
    expect(await s.next()).toBeNull();
  });

  it("records one level lower again when the follow-up is also missed, and lowers the claim", async () => {
    const w = world();
    const claim = w.claim("Rust", 3);
    const s = await w.start();
    await runSession(s, (p) => (p.topic === "Rust four" ? "no_idea" : "know"));
    s.judgeMiss(s.pendingMisses()[0]!.responseId, true);
    const follow = (await s.next())!;
    s.rate(follow.responseId, "no_idea");
    expect(s.pendingClaimDecisions()[0]!.gaps).toEqual([{ topic: "Rust four", level: 1 }]);
    s.decideClaim(topicId(w.store, "Rust"), "lower");
    expect(w.store.getMemory(claim.id).status).toBe("superseded");
    const lowered = w.store.listMemories({ status: "approved", kind: "competence" }).at(-1)!;
    expect(lowered.attrs).toMatchObject({ domain: "Rust", depth: 1, basis: "probed" });
    expect(w.store.memoryEvents(lowered.id).map((e) => e.actor)).toEqual(["person", "person"]);
  });

  it("changes nothing for a miss judged not a gap, and records 0 for a level-1 miss", async () => {
    const w = world();
    w.claim("Rust", 3);
    w.claim("Go", 1);
    const s = await w.start();
    await runSession(s, () => "no_idea");
    const misses = s.pendingMisses();
    const level1 = misses.find((m) => m.difficulty === 1)!;
    s.judgeMiss(level1.responseId, true);
    const rust = misses.find((m) => m.difficulty === 3)!;
    s.judgeMiss(rust.responseId, false);
    expect(w.store.listGaps().map((g) => [w.store.getTopic(g.nodeId).name, g.level])).toEqual([["Go four", 0]]);
  });

  it("surfaces a failed spot-check as a miss in the next session", async () => {
    const w = world({ size: 1, rng: queued([0.5, 0.0]) });
    w.claim("Rust", 3);
    const s = await w.start();
    const p = (await s.next())!;
    expect(s.rate(p.responseId, "know").spotCheck).toBe(true);
    s.answer(p.responseId, "Not sure.");
    await s.finish();
    const next = await w.start();
    expect(next.pendingMisses()).toEqual([expect.objectContaining({ responseId: p.responseId, reason: "failed_check" })]);
  });

  it("never shows a fixed miss, and shows a rotating one only after release", async () => {
    // Probe 1 fixed (0.05), probe 2 rotating (0.2), probe 3 none (0.5); "no idea" draws no spot-check.
    const w = world({ size: 3, rng: queued([0.05, 0.2, 0.5]) });
    w.claim("Rust", 3);
    const s = await w.start();
    await runSession(s, () => "no_idea");
    expect(s.pendingMisses().map((m) => m.topic)).toEqual(["Rust three"]);
    await s.finish();
    const next = await w.start();
    expect(next.pendingMisses().map((m) => m.topic).sort()).toEqual(["Rust one", "Rust three"]);
  });

  it("records a kept gap for a confirmed foundation miss", async () => {
    const w = world();
    const node = w.store.ensureTopic("Algorithms");
    const proposal = w.store.insertMemory(
      { kind: "competence", statement: "x", tier: 1, isCurrentState: false, attrs: { domain: "Algorithms", depth: 2, basis: "predicted", reasons: [] } },
      { sourceObservationIds: [], entityIds: [node.id], actor: "map" },
    );
    w.store.approve(proposal.id);
    const s = await w.start();
    await runSession(s, () => "no_idea");
    s.judgeMiss(s.pendingMisses()[0]!.responseId, true);
    expect(w.store.listGaps()).toEqual([expect.objectContaining({ nodeId: node.id, level: 1, status: "kept", source: "probe" })]);
  });
});

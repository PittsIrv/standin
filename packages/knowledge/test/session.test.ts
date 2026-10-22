import { describe, expect, it } from "vitest";
import { answerMode, loadSnapshot } from "../src/index.ts";
import { queued, topicId, world } from "./session-helpers.ts";

describe("ProbeSession", () => {
  it("records the prediction before the rating, and later approvals don't change it", async () => {
    const w = world({ size: 3 });
    w.claim("distributed systems", 3);
    const s = await w.start();
    const shown = (await s.next())!;
    expect(shown).toMatchObject({ kind: "claim", difficulty: 3, done: 1, total: 3 });
    const stored = w.store.getResponse(shown.responseId);
    expect(stored.predictedMode).toBe(answerMode(loadSnapshot(w.store), shown.nodeId).mode);
    expect(stored.predictedMode).toBe("explain");
    s.rate(shown.responseId, "know");
    expect(w.store.getResponse(shown.responseId).predictedMode).toBe("explain");
  });

  it("serves 40 probes in the first session, 10 later, or the size asked for", async () => {
    const w = world();
    for (const t of ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o"]) w.claim(t, 3);
    const first = await w.start();
    let count = 0;
    for (let p = await first.next(); p; p = await first.next()) {
      first.rate(p.responseId, "know");
      count++;
    }
    expect(count).toBe(40);
    await first.finish();
    const second = await w.start();
    count = 0;
    for (let p = await second.next(); p; p = await second.next()) {
      second.rate(p.responseId, "know");
      count++;
    }
    expect(count).toBe(5); // 15 claims × 3 = 45 probes in all; 40 were used first
  });

  it("sets a boundary at once on 'wouldn't say', and undoes it", async () => {
    const w = world({ size: 1 });
    w.claim("health", 3);
    const s = await w.start();
    const p = (await s.next())!;
    s.rate(p.responseId, "wouldnt_say");
    expect(w.store.getTopic(p.nodeId).boundaryTier).toBe(3);
    s.undoBoundary(p.nodeId);
    expect(w.store.getTopic(p.nodeId).boundaryTier).toBeNull();
  });

  it("makes exemplars from spot-checks only as the holdout set allows", async () => {
    // Per probe: the holdout draw when it is written, then the spot-check draw when it is rated.
    // Probe 1: none (0.5) + spot (0.0); probe 2: rotating (0.25) + spot; probe 3: fixed (0.05) + spot.
    const w = world({ size: 3, rng: queued([0.5, 0.0, 0.25, 0.0, 0.05, 0.0]) });
    w.claim("Rust", 3);
    const s = await w.start();
    const answers = ["Ownership moves values between owners.", "Borrowing lends a value without moving it.", "Lifetimes bound how long a reference lives."];
    const holdouts: string[] = [];
    for (let p = await s.next(), i = 0; p; p = await s.next(), i++) {
      expect(s.rate(p.responseId, "know").spotCheck).toBe(true);
      s.answer(p.responseId, answers[i]!);
      holdouts.push(w.store.getProbe(w.store.getResponse(p.responseId).probeId).holdout);
    }
    expect(holdouts).toEqual(["none", "rotating", "fixed"]);
    expect(w.store.listExemplars().map((e) => e.text)).toEqual([answers[0]]);
    await s.finish();
    expect(w.store.listExemplars().map((e) => e.text)).toEqual([answers[0], answers[1]]);
    await (await w.start()).finish();
    expect(w.store.listExemplars()).toHaveLength(2);
  });

  it("releases a crashed session's rotating probes when the next one starts", async () => {
    const w = world({ size: 1, rng: queued([0.2, 0.2]) });
    w.claim("Rust", 3);
    const crashed = await w.start();
    const p = (await crashed.next())!;
    crashed.rate(p.responseId, "know");
    expect(w.store.getProbe(w.store.getResponse(p.responseId).probeId)).toMatchObject({ holdout: "rotating", releasedAt: null });
    await w.start();
    expect(w.store.getProbe(w.store.getResponse(p.responseId).probeId).releasedAt).not.toBeNull();
    expect(w.store.listSessions()[0]!.endedAt).not.toBeNull();
  });

  it("starts with warnings and serves nothing when every model is down", async () => {
    const w = world({ failing: true });
    w.claim("Rust", 3);
    w.approve("fact", "I'm a CS student.", { background: true });
    const s = await w.start();
    expect(s.warnings.length).toBeGreaterThan(0);
    expect(await s.next()).toBeNull();
    expect(s.warnings.some((x) => x.includes("down"))).toBe(true);
  });

  it("records the session as review runs with model spans", async () => {
    const w = world({ size: 1 });
    w.claim("Rust", 3);
    const s = await w.start();
    await s.next();
    await s.finish();
    const spans = w.sink.spans.map((x) => x.span);
    const review = spans.filter((x) => x.parentSpanId === null && x.attributes["standin.run.kind"] === "review");
    expect(review.length).toBeGreaterThan(0);
    expect(new Set(review.map((x) => x.attributes["standin.review.session"]))).toEqual(new Set([w.store.listSessions()[0]!.id]));
  });

  it("probes the claimed node's parts after expanding it", async () => {
    const w = world({ size: 3 });
    w.claim("Rust", 3);
    const s = await w.start();
    const nodes: string[] = [];
    for (let p = await s.next(); p; p = await s.next()) {
      s.rate(p.responseId, "know");
      nodes.push(p.topic);
    }
    expect(nodes).toEqual(["Rust four", "Rust one", "Rust three"]);
    expect(w.store.getTopic(topicId(w.store, "Rust")).expandedAt).not.toBeNull();
  });
});

describe("session reads for the review page", () => {
  it("current() returns the shown, unrated probe until it is rated", async () => {
    const w = world({ size: 2 });
    w.claim("Rust", 3);
    const s = await w.start();
    expect(s.current()).toBeNull();
    const shown = (await s.next())!;
    expect(s.current()?.responseId).toBe(shown.responseId);
    expect(s.current()).toMatchObject({ done: 1, total: 2, question: shown.question });
    s.rate(shown.responseId, "roughly");
    expect(s.current()).toBeNull();
  });

  it("pendingSpotCheck() returns a requested check until it is answered", async () => {
    const w = world({ size: 1, rng: queued([0.5, 0.0]) });
    w.claim("Rust", 3);
    const s = await w.start();
    const shown = (await s.next())!;
    expect(s.rate(shown.responseId, "know")).toEqual({ spotCheck: true });
    expect(s.pendingSpotCheck()).toMatchObject({ responseId: shown.responseId, question: shown.question });
    s.answer(shown.responseId, "Ownership moves values.");
    expect(s.pendingSpotCheck()).toBeNull();
  });

  it("boundaries() lists nodes marked wouldn't say, and undo clears them", async () => {
    const w = world({ size: 1 });
    w.claim("Rust", 3);
    const s = await w.start();
    const shown = (await s.next())!;
    s.rate(shown.responseId, "wouldnt_say");
    expect(s.boundaries()).toEqual([{ nodeId: shown.nodeId, topic: shown.topic }]);
    s.undoBoundary(shown.nodeId);
    expect(s.boundaries()).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { computeLighting, loadSnapshot } from "../src/index.ts";
import { queued, world } from "./session-helpers.ts";

/** A world with background hypotheses on three nodes under a seeded field. */
function guessed(o: Parameters<typeof world>[0] = {}) {
  const w = world({ size: 10, ...o });
  const field = w.store.ensureTopic("Computer science");
  w.store.addEdge({ from: field.id, to: w.store.root("knowledge").id, kind: "part_of", source: "seeding" });
  const node = (name: string, depth: number, raw: "low" | "medium" | "high") => {
    const n = w.store.ensureTopic(name);
    w.store.addEdge({ from: n.id, to: field.id, kind: "part_of", source: "seeding" });
    return { n, h: w.store.insertHypothesis({ nodeId: n.id, depth, rawScore: raw, kind: "background", path: [field.id, n.id], reason: "core" }) };
  };
  return { w, field, node };
}

describe("probing hypotheses", () => {
  it("asks the most uncertain hypothesis first and stores its probabilities when shown", async () => {
    const { w, node } = guessed();
    w.store.setKv("priors", JSON.stringify({ "background:high": { a: 9, b: 1 } }));
    node("Algorithms", 2, "high");
    const systems = node("Systems", 2, "medium");
    const s = await w.start();
    const shown = (await s.next())!;
    expect(shown).toMatchObject({ kind: "hypothesis", nodeId: systems.n.id, difficulty: 2 });
    expect(w.store.getResponse(shown.responseId)).toMatchObject({ predictedP: 0.5, priorP: 0.5 });
  });

  it("confirms on know (lighting the node), refutes on no idea, and withdraws on wouldn't say with a boundary", async () => {
    const { w, node } = guessed();
    const a = node("Algorithms", 2, "medium");
    const b = node("Systems", 2, "medium");
    const c = node("Theory", 2, "medium");
    const s = await w.start();
    const ratings = new Map([[a.n.id, "know"], [b.n.id, "no_idea"], [c.n.id, "wouldnt_say"]] as const);
    for (let p = await s.next(); p; p = await s.next()) s.rate(p.responseId, ratings.get(p.nodeId)!);
    expect(w.store.getHypothesis(a.h.id).status).toBe("settled");
    expect(w.store.getHypothesis(b.h.id).status).toBe("settled");
    expect(w.store.getHypothesis(c.h.id).status).toBe("withdrawn");
    expect(w.store.getTopic(c.n.id).boundaryTier).toBe(3);
    const lit = computeLighting(loadSnapshot(w.store));
    expect(lit.get(a.n.id)).toMatchObject({ depth: 2, basis: "probed" });
    expect(lit.has(b.n.id)).toBe(false);
    expect((await s.finish()).settled).toBe(2);
  });

  it("asks twice at 4, both spot-checked", async () => {
    const { w, node } = guessed();
    const x = node("Distributed systems", 4, "high");
    const s = await w.start();
    const first = (await s.next())!;
    expect(s.rate(first.responseId, "know")).toEqual({ spotCheck: true });
    expect(w.store.getHypothesis(x.h.id).status).toBe("open");
    const second = (await s.next())!;
    expect(second).toMatchObject({ nodeId: x.n.id, difficulty: 4 });
    expect(s.rate(second.responseId, "know")).toEqual({ spotCheck: true });
    expect(w.store.getHypothesis(x.h.id).status).toBe("settled");
  });

  it("settles a rotating held-out hypothesis only when the session releases it", async () => {
    // First draw 0.15 puts the probe in the rotating set (10–30%).
    const { w, node } = guessed({ rng: queued([0.15]) });
    const a = node("Algorithms", 2, "medium");
    const s = await w.start();
    const p = (await s.next())!;
    s.rate(p.responseId, "know");
    expect(w.store.getHypothesis(a.h.id).status).toBe("open");
    const report = await s.finish();
    expect(w.store.getHypothesis(a.h.id).status).toBe("settled");
    expect(report.settled).toBe(1);
  });
});

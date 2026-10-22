import { loadSnapshot } from "@standin/knowledge";
import { describe, expect, it } from "vitest";
import { awaken, candidates } from "../src/index.ts";
import { fact, node, store } from "./helpers.ts";

const opts = { budget: 20, speakAt: 0.8 };

describe("route candidates", () => {
  it("ranks nodes by the words they share with the question, names counting double", () => {
    const s = store();
    const kite = node(s, "Kite", "work", "project");
    const pets = node(s, "Pets", "life", "pet");
    fact(s, pets.id, "I have two cats.");
    node(s, "Orbit", "work", "project");
    expect(candidates(s, "How did Kite turn out?").map((t) => t.name)).toEqual(["Kite"]);
    expect(candidates(s, "What are your cats' names?").map((t) => t.name)).toEqual(["Pets"]);
    expect(candidates(s, "Tell me about kite cats").map((t) => t.id)).toEqual([kite.id, pets.id]);
    expect(candidates(s, "the weather today")).toEqual([]);
  });

  it("never routes on words from memories a visitor may not see", () => {
    const s = store();
    const health = node(s, "Routines", "life");
    fact(s, health.id, "I take insulin every morning.", { tier: 4 });
    fact(s, health.id, "I see a therapist.", { approve: false });
    expect(candidates(s, "insulin therapist")).toEqual([]);
  });

  it("caps at n", () => {
    const s = store();
    for (const n of ["Go engine", "Go club", "Go teacher"]) node(s, n, "work", "project");
    expect(candidates(s, "Go", 2)).toHaveLength(2);
  });
});

describe("awaken", () => {
  it("gathers the seed's memories, and nearby ones that share a word, filtering what a visitor may not see", () => {
    const s = store();
    const pets = node(s, "Pets", "life", "pet");
    const ok = fact(s, pets.id, "I have two cats.");
    const secret = fact(s, pets.id, "My cats' vet is on Elm Street.", { tier: 4 });
    const pending = fact(s, pets.id, "The cats are named Miso and Tofu.", { approve: false });
    const life = s.root("life").id;
    const near = fact(s, life, "I adopted the cats in 2024.");
    fact(s, life, "I run on Sundays.");
    const a = awaken(s, "What are your cats called?", [pets.id], opts);
    expect(a.memories.map((m) => m.id).sort()).toEqual([ok.id, near.id].sort());
    expect(a.filtered).toEqual(expect.arrayContaining([{ id: secret.id, reason: "tier" }, { id: pending.id, reason: "status" }]));
    expect(a.hidden).toEqual(expect.arrayContaining([secret.statement, pending.statement]));
    expect(a.seeds).toEqual([{ id: pets.id, name: "Pets", root: "life", knowledge: false, mode: null, boundary: false }]);
  });

  it("marks a seed under a tier-3 node as a boundary and keeps its memories out", () => {
    const s = store();
    const fam = node(s, "Family", "people");
    s.setTopic(fam.id, { boundaryTier: 3 });
    const mom = node(s, "Mom", fam.id, "person");
    const m = fact(s, mom.id, "My mom lives in Ohio.");
    const a = awaken(s, "Where does your mom live?", [mom.id], opts);
    expect(a.seeds[0]!.boundary).toBe(true);
    expect(a.memories).toEqual([]);
    expect(a.filtered).toContainEqual({ id: m.id, reason: "boundary" });
  });

  it("keeps the best-matching memories up to the budget", () => {
    const s = store();
    const kite = node(s, "Kite", "work", "project");
    const best = fact(s, kite.id, "Kite trains a value net with self-play.");
    for (let i = 0; i < 4; i++) fact(s, kite.id, `Kite note ${i}.`);
    const a = awaken(s, "How does Kite use self-play?", [kite.id], { ...opts, budget: 2 });
    expect(a.memories).toHaveLength(2);
    expect(a.memories[0]!.id).toBe(best.id);
    expect(a.filtered.filter((f) => f.reason === "budget")).toHaveLength(3);
  });

  it("gives Knowledge seeds the answering rule's mode, and speaks a guess only at or above speakAt", () => {
    const s = store();
    const rl = node(s, "Reinforcement learning", "knowledge");
    const t = loadSnapshot(s);
    t.hypotheses.set(rl.id, { id: "hyp_1", depth: 3, p: 0.7, kind: "part", rawScore: "medium", reason: "r" });
    const low = awaken(s, "Do you know RL?", [rl.id], { ...opts, snapshot: t });
    expect(low.seeds[0]).toMatchObject({ knowledge: true, mode: "decline" });
    expect(low.hypotheses).toEqual([]);
    t.hypotheses.set(rl.id, { id: "hyp_1", depth: 3, p: 0.9, kind: "part", rawScore: "medium", reason: "r" });
    const high = awaken(s, "Do you know RL?", [rl.id], { ...opts, snapshot: t });
    expect(high.seeds[0]).toMatchObject({ mode: "brief" });
    expect(high.hypotheses).toEqual([{ nodeId: rl.id, name: "Reinforcement learning", depth: 3, p: 0.9 }]);
  });
});

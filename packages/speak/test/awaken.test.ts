import { loadSnapshot } from "@standin/knowledge";
import { describe, expect, it } from "vitest";
import { awaken, candidates } from "../src/index.ts";
import { fact, node, store, view } from "./helpers.ts";

const now = "2026-10-22T00:00:00.000Z";
const opts = { budget: 20, now };

describe("route candidates", () => {
  it("ranks nodes by the words they share with the question, names counting double", () => {
    const s = store();
    const kite = node(s, "Kite", "work", "project");
    fact(s, kite.id, "I built it in 2025.");
    const pets = node(s, "Pets", "life", "pet");
    fact(s, pets.id, "I have two cats.");
    fact(s, node(s, "Orbit", "work", "project").id, "A side project.");
    expect(candidates(view(s), "How did Kite turn out?", now).map((t) => t.name)).toEqual(["Kite"]);
    expect(candidates(view(s), "What are your cats' names?", now).map((t) => t.name)).toEqual(["Pets"]);
    expect(candidates(view(s), "Tell me about kite cats", now).map((t) => t.id)).toEqual([kite.id, pets.id]);
    expect(candidates(view(s), "the weather today", now)).toEqual([]);
  });

  it("never routes on words from memories a visitor may not see", () => {
    const s = store();
    const health = node(s, "Routines", "life");
    fact(s, health.id, "I take insulin every morning.", { tier: 4 });
    fact(s, health.id, "I see a therapist.", { approve: false });
    expect(candidates(view(s), "insulin therapist", now)).toEqual([]);
  });

  it("caps at n", () => {
    const s = store();
    for (const n of ["Go engine", "Go club", "Go teacher"]) fact(s, node(s, n, "work", "project").id, "Started in 2024.");
    expect(candidates(view(s), "Go", now, 2)).toHaveLength(2);
  });
});

describe("awaken", () => {
  it("gathers the seed's memories, and nearby ones that share a word; what a visitor may not see isn't there to gather", () => {
    const s = store();
    const pets = node(s, "Pets", "life", "pet");
    const ok = fact(s, pets.id, "I have two cats.");
    const secret = fact(s, pets.id, "My cats' vet is on Elm Street.", { tier: 4 });
    const pending = fact(s, pets.id, "The cats are named Miso and Tofu.", { approve: false });
    const life = s.root("life").id;
    const near = fact(s, life, "I adopted the cats in 2024.");
    fact(s, life, "I run on Sundays.");
    const a = awaken(view(s), "What are your cats called?", [pets.id], opts);
    expect(a.memories.map((m) => m.id).sort()).toEqual([ok.id, near.id].sort());
    expect(JSON.stringify(a)).not.toContain(secret.id);
    expect(JSON.stringify(a)).not.toContain(pending.id);
    expect(a.seeds).toEqual([{ id: pets.id, name: "Pets", root: "life", knowledge: false, mode: null }]);
  });

  it("can't reach a tier-3 branch: it isn't in the bundle", () => {
    const s = store();
    const fam = node(s, "Family", "people");
    s.setTopic(fam.id, { boundaryTier: 3 });
    const mom = node(s, "Mom", fam.id, "person");
    fact(s, mom.id, "My mom lives in Ohio.");
    const v = view(s);
    expect(candidates(v, "Where does your mom live?", now)).toEqual([]);
    expect(awaken(v, "Where does your mom live?", [mom.id], opts)).toEqual({ seeds: [], memories: [], hypotheses: [], filtered: [] });
  });

  it("filters a memory that expired after the bundle was built", () => {
    const s = store();
    const pets = node(s, "Pets", "life", "pet");
    const m = fact(s, pets.id, "I'm fostering a kitten this month.");
    s.db.prepare("UPDATE memories SET valid_until = ? WHERE id = ?").run("2099-12-01T00:00:00.000Z", m.id);
    const a = awaken(view(s), "Tell me about the kitten", [pets.id], { ...opts, now: "2100-01-01T00:00:00.000Z" });
    expect(a.memories).toEqual([]);
    expect(a.filtered).toEqual([{ id: m.id, reason: "expired" }]);
  });

  it("keeps the best-matching memories up to the budget", () => {
    const s = store();
    const kite = node(s, "Kite", "work", "project");
    const best = fact(s, kite.id, "Kite trains a value net with self-play.");
    for (let i = 0; i < 4; i++) fact(s, kite.id, `Kite note ${i}.`);
    const a = awaken(view(s), "How does Kite use self-play?", [kite.id], { ...opts, budget: 2 });
    expect(a.memories).toHaveLength(2);
    expect(a.memories[0]!.id).toBe(best.id);
    expect(a.filtered.filter((f) => f.reason === "budget")).toHaveLength(3);
  });

  it("gives Knowledge seeds the answering rule's mode, and speaks a guess only at or above speakAt", () => {
    const s = store();
    const rl = node(s, "Reinforcement learning", "knowledge");
    const t = loadSnapshot(s);
    t.hypotheses.set(rl.id, { id: "hyp_1", depth: 3, p: 0.7, kind: "part", rawScore: "medium", reason: "r" });
    const low = awaken(view(s, t), "Do you know RL?", [rl.id], opts);
    expect(low.seeds).toEqual([]); // nothing to publish about it, so it isn't in the bundle
    expect(low.hypotheses).toEqual([]);
    t.hypotheses.set(rl.id, { id: "hyp_1", depth: 3, p: 0.9, kind: "part", rawScore: "medium", reason: "r" });
    const high = awaken(view(s, t), "Do you know RL?", [rl.id], opts);
    expect(high.seeds[0]).toMatchObject({ knowledge: true, mode: "brief" });
    expect(high.hypotheses).toEqual([{ nodeId: rl.id, name: "Reinforcement learning", depth: 3 }]);
  });
});

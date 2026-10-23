import { loadSnapshot } from "@standin/knowledge";
import { Bundle } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { buildBundle, diffBundles, scanBundle } from "../src/index.ts";
import { fact, lit, node, store } from "./helpers.ts";

const opts = { personaName: "Lin", speakAt: 0.8 };
// Built at run time so no key-shaped string sits in the repo.
const TOKEN = "ghp_" + "aB3kQ9zX7mW2pL5vR8tY4nC6aB3kQ9zX7mW2".slice(0, 36);

describe("building the bundle (publish spec §2)", () => {
  it("holds approved tier 1–2 memories that haven't expired, and nothing else", () => {
    const s = store();
    const pets = node(s, "Pets", "life", "pet");
    const ok = fact(s, pets.id, "I have two cats.");
    const two = fact(s, pets.id, "My cats are named after rivers.", { tier: 2 });
    fact(s, pets.id, "The cats were a breakup gift.", { tier: 3 });
    fact(s, pets.id, "I pay the vet monthly.", { tier: 4 });
    fact(s, pets.id, "I want a dog.", { approve: false });
    const old = fact(s, pets.id, "I had a hamster.");
    s.expire(old.id);
    const b = buildBundle(s, opts);
    expect(Bundle.parse(b)).toEqual(b);
    expect(b.memories.map((m) => m.id).sort()).toEqual([ok.id, two.id].sort());
    expect(b.memories.find((m) => m.id === ok.id)).toEqual({ id: ok.id, statement: "I have two cats.", kind: "fact", tier: 1, nodes: [pets.id], validUntil: null });
  });

  it("includes nodes that carry something, with their path to the root, and leaves empty nodes out", () => {
    const s = store();
    const proj = node(s, "Projects", "work");
    const kite = node(s, "Kite", proj.id, "project");
    const empty = node(s, "Side ideas", proj.id);
    fact(s, kite.id, "Kite is a poker solver.");
    const b = buildBundle(s, opts);
    const names = b.nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["Kite", "Projects"]));
    expect(names).not.toContain("Side ideas");
    expect(b.nodes.find((n) => n.id === kite.id)).toMatchObject({ parent: proj.id, root: "work", answer: null });
    expect(b.nodes.some((n) => n.id === empty.id)).toBe(false);
  });

  it("leaves out a boundary and everything under it, even its name, and a memory that names it", () => {
    const s = store();
    const fam = node(s, "Family", "people");
    s.setTopic(fam.id, { boundaryTier: 3 });
    const mom = node(s, "Mom", fam.id, "person");
    fact(s, mom.id, "My mom lives in Ohio.");
    const pets = node(s, "Pets", "life", "pet");
    const both = fact(s, pets.id, "Mom looks after my cats.");
    s.db.prepare("INSERT INTO memory_entities (memory_id, entity_id) VALUES (?, ?)").run(both.id, mom.id);
    const json = JSON.stringify(buildBundle(s, opts));
    expect(json).not.toMatch(/Family|Mom|Ohio/);
  });

  it("works out answering modes, so levels, gaps and guess reasons stay private", () => {
    const s = store();
    const cs = node(s, "Computer science", "knowledge");
    const rl = node(s, "Reinforcement learning", cs.id);
    const mcts = node(s, "Monte Carlo tree search", rl.id);
    const go = node(s, "Go engines", cs.id);
    lit(s, rl.id, "Knows reinforcement learning well.", 3);
    const t = loadSnapshot(s);
    t.hypotheses.set(go.id, { id: "hyp_1", depth: 2, p: 0.9, kind: "part", rawScore: "medium", reason: "wrote about AlphaGo in a private journal" });
    const b = buildBundle(s, { ...opts, snapshot: t });
    const by = (id: string) => b.nodes.find((n) => n.id === id);
    expect(by(rl.id)!.answer).toEqual({ mode: "explain", depth: 3, via: "own" });
    expect(by(go.id)!.answer).toMatchObject({ depth: 2, via: "guess" });
    expect(by(cs.id)).toBeDefined(); // on the path to the root
    expect(by(mcts.id)).toBeUndefined(); // inherits a level but carries nothing of its own
    const json = JSON.stringify(b);
    expect(json).not.toMatch(/private journal|private notes|hyp_1|0\.9/);
  });

  it("leaves out a concept known only as not known: the reply is \"I don't know.\" either way", () => {
    const s = store();
    const cs = node(s, "Computer science", "knowledge");
    const quantum = node(s, "Quantum computing", cs.id);
    const t = loadSnapshot(s);
    t.stated.set(quantum.id, 0);
    expect(buildBundle(s, { ...opts, snapshot: t }).nodes.map((n) => n.name)).not.toContain("Quantum computing");
  });

  it("holds approved exemplars only", () => {
    const s = store();
    const o = s.addObservation({ sourceKind: "manual", sourceRef: "t", authorRole: "self", text: "x", occurredAt: "2026-09-01T00:00:00.000Z" });
    const a = s.insertExemplar({ observationId: o.id, text: "lol the meeting ran late", register: "casual" })!;
    s.approveExemplar(a.id);
    s.insertExemplar({ observationId: o.id, text: "not approved yet", register: "casual" });
    expect(buildBundle(s, opts).exemplars).toEqual([{ id: a.id, text: "lol the meeting ran late", register: "casual" }]);
  });
});

describe("what changed and the final scan (publish spec §4)", () => {
  it("lists items added, changed and removed", () => {
    const s = store();
    const pets = node(s, "Pets", "life", "pet");
    const a = fact(s, pets.id, "I have two cats.");
    const gone = fact(s, pets.id, "I had a hamster.");
    const before = buildBundle(s, opts);
    s.retract(gone.id);
    s.renameTopic(pets.id, "Animals");
    const added = fact(s, pets.id, "I foster kittens.");
    const changes = diffBundles(before, buildBundle(s, opts));
    expect(changes.map((c) => [c.change, c.key])).toEqual(
      expect.arrayContaining([
        ["changed", `node:${pets.id}`],
        ["added", `memory:${added.id}`],
        ["removed", `memory:${gone.id}`],
      ]),
    );
    expect(changes.find((c) => c.key === `node:${pets.id}`)).toMatchObject({ label: "Animals", was: "Pets" });
    expect(changes.some((c) => c.key === `memory:${a.id}`)).toBe(false);
    expect(diffBundles(null, before).every((c) => c.change === "added")).toBe(true);
  });

  it("finds a secret that slipped in before the guard, by item and field, masked", () => {
    const s = store();
    const tools = node(s, "Tools", "work");
    const m = fact(s, tools.id, "I use GitHub.");
    s.db.prepare("UPDATE memories SET statement = ? WHERE id = ?").run(`I use GitHub, token ${TOKEN}.`, m.id);
    const found = scanBundle(buildBundle(s, opts));
    expect(found).toEqual([expect.objectContaining({ key: `memory:${m.id}`, where: `memory ${m.id} statement`, label: "GitHub token", kind: "secret" })]);
    expect(JSON.stringify(found)).not.toContain(TOKEN.slice(4));
  });
});

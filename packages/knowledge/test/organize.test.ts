import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore, type Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { homeMemories, splitNodes } from "../src/index.ts";

function setup() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-organize-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const fact = (statement: string, home: string | null = null) => {
    const m = store.insertMemory(
      { kind: "fact", statement, tier: 1, isCurrentState: false, attrs: {} },
      { sourceObservationIds: [o.id], entityIds: [], actor: "compaction", homeNodeId: home },
    );
    return store.approve(m.id);
  };
  return { store, fact };
}

/** A Pets node under Life holding `n` facts: two about Miso, one about Tofu, the rest shared. */
function crowdedPets(store: Store, fact: (s: string, home: string | null) => { id: string }, n: number) {
  const pets = store.ensureNode("Pets", "other");
  store.addEdge({ from: pets.id, to: store.root("life").id, kind: "part_of", source: "placement" });
  const miso = [fact("Miso is the shy one.", pets.id).id, fact("Miso hates the car.", pets.id).id];
  const tofu = [fact("Tofu was adopted in 2023.", pets.id).id];
  for (let i = miso.length + tofu.length; i < n; i++) fact(`We hike together, week ${i}.`, pets.id);
  return { pets, miso, tofu };
}

const splitInto = (miso: string[], tofu: string[]) => () => ({
  children: [
    { name: "Miso", label: "pet", definition: "The shy cat.", memoryIds: miso },
    { name: "Tofu", label: "pet", definition: "The younger cat.", memoryIds: [...tofu, "mem_000000000000"] },
    { name: "Pets", label: "other", definition: "Itself.", memoryIds: [] },
  ],
});

describe("homing memories", () => {
  it("homes a homeless fact in a new node under the parent the model names, ignoring unknown ids", async () => {
    const { store, fact } = setup();
    const cats = fact("I have two cats.");
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.purpose).toBe("home");
      expect(req.prompt).toContain(`[${cats.id}] I have two cats.`);
      return {
        homes: [
          { memoryId: cats.id, node: "Pets", newNode: { parent: "Life", label: "other", definition: "Animals I live with." } },
          { memoryId: "mem_000000000000", node: "Nowhere", newNode: null },
        ],
      };
    });
    const report = await homeMemories(store, llm, "Lin Qiao");
    expect(report).toMatchObject({ homed: 1, created: ["Pets"] });
    const pets = store.getMemory(cats.id).homeNodeId!;
    expect(store.getTopic(pets).name).toBe("Pets");
    expect(store.rootOf(pets)).toBe("life");
  });

  it("does nothing, and makes no call, when every approved memory has a home", async () => {
    const { store, fact } = setup();
    fact("Homed.", store.root("life").id);
    const llm = new ScriptedLLM(() => ({ homes: [] }));
    expect(await homeMemories(store, llm, "Lin Qiao")).toMatchObject({ homed: 0 });
    expect(llm.calls).toHaveLength(0);
  });
});

describe("splitting nodes", () => {
  it("splits a node over the threshold, moving only the listed facts it holds and skipping a child named like itself", async () => {
    const { store, fact } = setup();
    const { pets, miso, tofu } = crowdedPets(store, fact, 13);
    const report = await splitNodes(store, new ScriptedLLM(splitInto(miso, tofu)), "Lin Qiao", 12);
    expect(report.split).toEqual(["Pets"]);
    const child = (name: string) => store.listTopics().find((t) => t.name === name && store.homeParent(t.id) === pets.id)!;
    expect(store.nodeMemories(child("Miso").id).map((m) => m.id)).toEqual(miso);
    expect(store.nodeMemories(child("Tofu").id).map((m) => m.id)).toEqual(tofu);
    expect(store.nodeMemories(pets.id)).toHaveLength(10);
    expect(store.listTopics().filter((t) => t.name === "Pets")).toHaveLength(1);
  });

  it("asks about a crowded node once, and again only after it gains facts", async () => {
    const { store, fact } = setup();
    const { pets } = crowdedPets(store, fact, 13);
    const llm = new ScriptedLLM(() => ({ children: [] }));
    await splitNodes(store, llm, "Lin Qiao", 12);
    await splitNodes(store, llm, "Lin Qiao", 12);
    expect(llm.calls).toHaveLength(1);
    fact("We got a new scratching post.", pets.id);
    await splitNodes(store, llm, "Lin Qiao", 12);
    expect(llm.calls).toHaveLength(2);
  });

  it("leaves a node at the threshold alone", async () => {
    const { store, fact } = setup();
    const { miso, tofu } = crowdedPets(store, fact, 12);
    const llm = new ScriptedLLM(splitInto(miso, tofu));
    expect((await splitNodes(store, llm, "Lin Qiao", 12)).split).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it("checks a node that just gained a child even below the threshold", async () => {
    const { store, fact } = setup();
    const { pets, miso, tofu } = crowdedPets(store, fact, 4);
    const report = await splitNodes(store, new ScriptedLLM(splitInto(miso, tofu)), "Lin Qiao", 12, new Set([pets.id]));
    expect(report.split).toEqual(["Pets"]);
  });
});

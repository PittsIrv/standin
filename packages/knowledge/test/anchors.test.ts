import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore, type Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { anchorConcepts, loadFrame, shortlist } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-anchor-")), "db") });
/** A Knowledge concept placed at the top, by a step (or by the person). */
const top = (s: Store, name: string, definition: string | null = null, source: "placement" | "person" = "placement") => {
  const n = s.ensureTopic(name, definition);
  s.addEdge({ from: n.id, to: s.root("knowledge").id, kind: "part_of", source });
  return n;
};
const parentName = (s: Store, id: string) => {
  const p = s.homeParent(id);
  return p ? s.getTopic(p).name : null;
};
/** Picks, for each concept, the candidate whose name is given (or none). */
const picker = (choose: Record<number, string | null>) =>
  new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
    expect(req.purpose).toBe("anchor");
    const anchors = Object.entries(choose).map(([n, name]) => {
      const block = req.prompt.split(/\n(?=\[\d+\])/).find((b) => b.startsWith(`[${n}]`)) ?? "";
      const id = name ? new RegExp(`(\\d+) ${name} \\(`).exec(block)?.[1] ?? "nope" : null;
      return { concept: Number(n), subfield: id };
    });
    return { anchors };
  });

describe("the OpenAlex frame", () => {
  it("has its fields and subfields", () => {
    const f = loadFrame();
    expect([f.fields.length, f.subfields.length]).toEqual([26, 252]);
    expect(f.subfields.find((s) => s.name === "Artificial Intelligence")).toMatchObject({ fieldId: "17" });
  });

  it("ranks the subfields a concept shares the most telling words with", () => {
    const names = (c: Parameters<typeof shortlist>[0]) => shortlist(c).map((s) => s.name);
    expect(names({ name: "Reinforcement learning", definition: "Learning to act from rewards.", examples: ["Q-learning", "policy gradients"] }).slice(0, 3)).toContain("Artificial Intelligence");
    expect(names({ name: "Graph algorithms", definition: null, examples: [] })).toContain("Computational Theory and Mathematics");
    expect(shortlist({ name: "Reinforcement learning", definition: null, examples: [] })).toHaveLength(10);
    expect(shortlist({ name: "Xyzzy", definition: null, examples: [] })).toEqual([]);
  });
});

describe("anchoring concepts", () => {
  it("places a top-level concept under the subfield and field the model picks, making them only now", async () => {
    const s = store();
    const rl = top(s, "Reinforcement learning", "Learning to act from rewards.");
    const llm = picker({ 1: "Artificial Intelligence" });
    expect(await anchorConcepts(s, llm, "Lin")).toEqual({ anchored: ["Reinforcement learning"] });
    expect(parentName(s, rl.id)).toBe("Artificial Intelligence");
    const ai = s.findByAnchor("openalex:subfield:1702")!;
    expect(parentName(s, ai.id)).toBe("Computer Science");
    expect(s.findByAnchor("openalex:field:17")!.id).toBe(s.homeParent(ai.id));
    expect(parentName(s, s.homeParent(ai.id)!)).toBe("Knowledge");
    expect(s.listEdges("part_of").find((e) => e.from === rl.id)?.source).toBe("anchor");
  });

  it("makes a concept named like a field or subfield that frame node, with no model call", async () => {
    const s = store();
    const cs = top(s, "Computer science");
    const ai = top(s, "Artificial intelligence");
    const llm = picker({});
    await anchorConcepts(s, llm, "Lin");
    expect(llm.calls).toHaveLength(0);
    expect(s.getTopic(cs.id).anchor).toBe("openalex:field:17");
    expect(s.getTopic(ai.id).anchor).toBe("openalex:subfield:1702");
    expect(s.homeParent(ai.id)).toBe(cs.id);
    expect(s.getTopic(cs.id).name).toBe("Computer science");
  });

  it("reuses the frame nodes it already has", async () => {
    const s = store();
    const cs = top(s, "Computer science");
    top(s, "Reinforcement learning");
    top(s, "Planning");
    await anchorConcepts(s, picker({ 1: "Artificial Intelligence", 2: "Artificial Intelligence" }), "Lin");
    const ai = s.findByAnchor("openalex:subfield:1702")!;
    expect(s.homeParent(ai.id)).toBe(cs.id);
    expect(s.listTopics().filter((t) => s.homeParent(t.id) === ai.id).map((t) => t.name).sort()).toEqual(["Planning", "Reinforcement learning"]);
  });

  it("leaves a concept where it is when the model says none or picks something not on its list, and asks once", async () => {
    const s = store();
    const poker = top(s, "Poker strategy", "Winning at poker.");
    const rl = top(s, "Reinforcement learning");
    const llm = picker({ 1: null, 2: "Dentistry" });
    await anchorConcepts(s, llm, "Lin");
    await anchorConcepts(s, llm, "Lin");
    expect(llm.calls).toHaveLength(1);
    expect([parentName(s, poker.id), parentName(s, rl.id)]).toEqual(["Knowledge", "Knowledge"]);
  });

  it("never moves what the person placed, or a concept with a parent of its own", async () => {
    const s = store();
    top(s, "Reinforcement learning", null, "person");
    const ml = top(s, "Machine learning");
    const nn = s.ensureTopic("Neural networks");
    s.addEdge({ from: nn.id, to: ml.id, kind: "part_of", source: "expansion" });
    const llm = picker({ 1: "Artificial Intelligence" });
    await anchorConcepts(s, llm, "Lin");
    expect(llm.calls[0]!.prompt).not.toMatch(/Reinforcement learning|Neural networks/);
    expect(parentName(s, nn.id)).toBe("Machine learning");
    expect(parentName(s, s.ensureTopic("Reinforcement learning").id)).toBe("Knowledge");
  });

  it("doesn't bring back a frame node the person deleted", async () => {
    const s = store();
    top(s, "Reinforcement learning");
    await anchorConcepts(s, picker({ 1: "Artificial Intelligence" }), "Lin");
    s.deleteTopic(s.findByAnchor("openalex:subfield:1702")!.id);
    const planning = top(s, "Planning");
    await anchorConcepts(s, picker({ 1: "Artificial Intelligence" }), "Lin");
    expect(s.findByAnchor("openalex:subfield:1702")).toBeNull();
    expect(parentName(s, planning.id)).toBe("Knowledge");
  });

  it("doesn't match by name a subfield whose name two fields share, and finds a renamed field by its anchor", async () => {
    const s = store();
    const genetics = top(s, "Genetics");
    const cs = top(s, "Computer science");
    await anchorConcepts(s, picker({ 1: null }), "Lin");
    expect(s.getTopic(genetics.id).anchor).toBeNull();
    s.renameTopic(cs.id, "Computing");
    top(s, "Reinforcement learning");
    await anchorConcepts(s, picker({ 1: "Artificial Intelligence" }), "Lin");
    expect(s.homeParent(s.findByAnchor("openalex:subfield:1702")!.id)).toBe(cs.id);
  });
});

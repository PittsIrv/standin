import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM } from "@standin/llm";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { checkSplit, expandNode } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-split-")), "db") });
const part = (name: string, level: number, examples = [`${name} example A`, `${name} example B`, `${name} example C`]) => ({ name, definition: `${name}.`, level, examples });
const GOOD = { components: [part("Rewards", 1), part("Policies", 2), part("Value functions", 2), part("Async RL", 4)], prerequisites: [] };

describe("splits", () => {
  it("stores each new part with its level, on the frontier", async () => {
    const s = store();
    const rl = s.ensureTopic("Reinforcement learning");
    await expandNode(s, new ScriptedLLM(() => GOOD), rl.id, "Lin Qiao");
    const parts = s.listTopics().filter((t) => s.homeParent(t.id) === rl.id);
    expect(parts.map((p) => [p.name, p.partLevel, p.frontier]).sort()).toEqual([
      ["Async RL", 4, true],
      ["Policies", 2, true],
      ["Rewards", 1, true],
      ["Value functions", 2, true],
    ]);
  });

  it("finds the problems in a junk split", () => {
    const s = store();
    const rl = s.renameTopic(s.ensureTopic("RL").id, "Reinforcement learning");
    const { ok, problems } = checkSplit(rl, [part("RL", 2), part("Rewards", 9), part("Policies", 2), part("policies", 3)]);
    expect(ok.map((p) => p.name)).toEqual(["Policies"]);
    expect(problems.join("\n")).toMatch(/itself/);
    expect(problems.join("\n")).toMatch(/level/);
    expect(problems.join("\n")).toMatch(/duplicate/);
    expect(problems.join("\n")).toMatch(/3–7 parts/);
  });

  it("stores each part's examples, and never replaces examples already there", async () => {
    const s = store();
    const rl = s.ensureTopic("Reinforcement learning");
    s.setTopic(s.ensureTopic("Rewards").id, { examples: ["my own example"] });
    await expandNode(s, new ScriptedLLM(() => GOOD), rl.id, "Lin Qiao");
    expect(s.ensureTopic("Policies").examples).toEqual(["Policies example A", "Policies example B", "Policies example C"]);
    expect(s.ensureTopic("Rewards").examples).toEqual(["my own example"]);
  });

  it("refuses names that give a level or a bucket instead of content", () => {
    const s = store();
    const algo = s.ensureTopic("Algorithms");
    const names = ["Advanced algorithm fundamentals", "Basics of sorting", "Other topics", "Intermediate graphs", "Network flow and matching", "Foundations of hashing"];
    const { ok, problems } = checkSplit(algo, names.map((n) => part(n, 2)));
    expect(ok.map((p) => p.name)).toEqual(["Network flow and matching"]);
    expect(problems.filter((p) => /describes its content/.test(p))).toHaveLength(5);
  });

  it("does not mistake content words for level words", () => {
    const s = store();
    const ml = s.ensureTopic("Machine learning");
    const { ok } = checkSplit(ml, [part("Generalization bounds", 3), part("Basin hopping", 3), part("Otherworldly search", 2)]);
    expect(ok).toHaveLength(3);
  });

  it("needs 3 distinct examples per part, and keeps at most 5", () => {
    const s = store();
    const algo = s.ensureTopic("Algorithms");
    const { ok, problems } = checkSplit(algo, [
      part("Sorting", 1, ["quicksort", "Quicksort", "Sorting"]),
      part("Graph search", 2, ["BFS", "DFS", "Dijkstra", "A*", "Bellman-Ford", "Floyd-Warshall"]),
      part("Hashing", 2, ["hash tables", "collisions", "universal hashing"]),
    ]);
    expect(ok.map((p) => p.name)).toEqual(["Graph search", "Hashing"]);
    expect(ok[0]!.examples).toEqual(["BFS", "DFS", "Dijkstra", "A*", "Bellman-Ford"]);
    expect(problems.join("\n")).toMatch(/"Sorting" needs 3–5 concrete examples/);
  });

  it("retries a junk split once, then keeps only the valid parts", async () => {
    const s = store();
    const rl = s.ensureTopic("Reinforcement learning");
    const llm = new ScriptedLLM(() => ({ components: [part("Reinforcement learning", 2), part("Rewards", 9)], prerequisites: [] }));
    await expandNode(s, llm, rl.id, "Lin Qiao");
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]!.prompt).toMatch(/Problems with your last answer/);
    expect(s.listTopics().filter((t) => s.homeParent(t.id) === rl.id)).toEqual([]);
  });

  it("never overwrites a part level that is already set", async () => {
    const s = store();
    const rl = s.ensureTopic("Reinforcement learning");
    s.setTopic(s.ensureTopic("Rewards").id, { partLevel: 3 });
    await expandNode(s, new ScriptedLLM(() => GOOD), rl.id, "Lin Qiao");
    expect(s.ensureTopic("Rewards").partLevel).toBe(3);
  });
});

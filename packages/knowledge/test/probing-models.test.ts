import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { assignHoldout, expandNode, writeProbes } from "../src/index.ts";

const temp = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-probe-")), "db") });

/** A deterministic rng: a linear congruential generator. */
export function lcg(seed = 42): () => number {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 2 ** 32;
    return x / 2 ** 32;
  };
}

describe("expandNode", () => {
  it("adds parts and prerequisites once, and skips a part that would make a cycle", async () => {
    const store = temp();
    const ds = store.ensureTopic("distributed systems");
    const parent = store.ensureTopic("Systems");
    store.addEdge({ from: ds.id, to: parent.id, kind: "part_of", source: "seeding" });
    const llm = new ScriptedLLM(() => ({
      components: ["consensus", "replication", "partitioning", "fault tolerance", "Systems"].map((name) => ({ name, definition: `${name}.`, level: 2 })),
      prerequisites: [{ name: "networking", definition: "How computers talk." }],
    }));
    const out = await expandNode(store, llm, ds.id, "Lin Qiao");
    expect(out.components).toEqual(["consensus", "replication", "partitioning", "fault tolerance"]);
    expect(out.prerequisites).toEqual(["networking"]);
    expect(store.getTopic(ds.id).expandedAt).not.toBeNull();
    expect(store.listEdges("requires").map((e) => store.getTopic(e.to).name)).toEqual(["networking"]);
    await expandNode(store, llm, ds.id, "Lin Qiao");
    expect(llm.calls).toHaveLength(1);
  });
});

describe("writeProbes", () => {
  it("stores probes with a holdout each, dropping blank questions", async () => {
    const store = temp();
    const node = store.ensureTopic("consensus", "Agreeing on a value across machines.");
    const llm = new ScriptedLLM((req: GenerateObjectRequest<unknown>) => {
      expect(req.purpose).toBe("quiz");
      expect(req.prompt).toContain("consensus");
      return { probes: [{ question: "Could you explain how Raft elects a leader?" }, { question: "  " }, { question: "Could you say why Paxos needs a majority?" }] };
    });
    const probes = await writeProbes(store, llm, { nodeId: node.id, difficulty: 3, kind: "claim", checkOf: node.id, count: 2, rng: () => 0.5 });
    expect(probes.map((p) => [p.difficulty, p.kind, p.holdout])).toEqual([
      [3, "claim", "none"],
      [3, "claim", "none"],
    ]);
  });
});

describe("assignHoldout", () => {
  it("holds out about 10% fixed and 20% rotating", () => {
    const rng = lcg();
    const counts = { none: 0, fixed: 0, rotating: 0 };
    for (let i = 0; i < 10_000; i++) counts[assignHoldout(rng)]++;
    expect(counts.fixed / 10_000).toBeCloseTo(0.1, 1);
    expect(Math.abs(counts.fixed / 10_000 - 0.1)).toBeLessThan(0.01);
    expect(Math.abs(counts.rotating / 10_000 - 0.2)).toBeLessThan(0.01);
  });
});

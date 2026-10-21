import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoLLM } from "@standin/demo-persona";
import { checkSplit, ExpandSchema } from "@standin/knowledge";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";

describe("the demo's splits", () => {
  it("pass the split checks, hand-written and fallback alike", async () => {
    const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-demo-")), "db") });
    const llm = demoLLM();
    for (const topic of ["Algorithms", "Graph algorithms", "Systems", "Machine learning", "Reinforcement learning", "Theory of computation", "Software engineering", "Game AI", "Programming languages", "Japanese"]) {
      const out = await llm.generateObject({ system: "", prompt: `Topic: ${topic}`, schema: ExpandSchema, purpose: "expand" });
      expect(checkSplit(store.ensureTopic(topic), out.components).problems, topic).toEqual([]);
    }
  });
});

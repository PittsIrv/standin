import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoLLM } from "@standin/demo-persona";
import { AnchorSchema, checkSplit, ExpandSchema, IntroSchema } from "@standin/knowledge";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";

describe("the demo's splits", () => {
  it("pass the split checks, and give no parts for a concept they don't cover", async () => {
    const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-demo-")), "db") });
    const llm = demoLLM();
    for (const topic of ["Algorithms", "Graph algorithms", "Systems", "Machine learning", "Reinforcement learning", "Theory of computation", "Software engineering", "Game AI", "Programming languages"]) {
      const out = await llm.generateObject({ system: "", prompt: `Topic: ${topic}`, schema: ExpandSchema, purpose: "expand" });
      expect(checkSplit(store.ensureTopic(topic), out.components).problems, topic).toEqual([]);
    }
    expect((await llm.generateObject({ system: "", prompt: "Topic: Japanese", schema: ExpandSchema, purpose: "expand" })).components).toEqual([]);
  });
});

describe("the demo's reading of a source", () => {
  it("keeps a résumé entry's title lines together, and each bullet and sentence apart", async () => {
    const text = "Software Engineer Intern May 2025 – Aug 2025\nAlpSoft, Singapore\n• Maintained sites for EnterpriseSG.\n• Supported deployments on AWS\nI like chess. I play weekly.";
    const out = (await demoLLM().generateObject({ system: "", prompt: `Source: cv.pdf\n<source>\n${text}\n</source>`, schema: IntroSchema, purpose: "intro" })) as { statements: { statement: string }[] };
    expect(out.statements.map((s) => s.statement)).toEqual([
      "Software Engineer Intern May 2025 – Aug 2025 AlpSoft, Singapore",
      "Maintained sites for EnterpriseSG.",
      "Supported deployments on AWS",
      "I like chess.",
      "I play weekly.",
    ]);
  });
});

describe("the demo's anchoring", () => {
  it("picks each concept's first candidate", async () => {
    const prompt = "[1] Reinforcement learning: Learning from rewards.\n  1702 Artificial Intelligence (Computer Science)\n  2207 Control and Systems Engineering (Engineering)\n[2] Graphs\n  1703 Computational Theory and Mathematics (Computer Science)";
    expect(await demoLLM().generateObject({ system: "", prompt, schema: AnchorSchema, purpose: "anchor" })).toEqual({ anchors: [{ concept: 1, subfield: "1702" }, { concept: 2, subfield: "1703" }] });
  });
});

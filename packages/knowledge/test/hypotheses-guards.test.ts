import type { TopicEdge } from "@standin/schema";
import { describe, expect, it } from "vitest";
import { checkHypothesis, isSensitive } from "../src/index.ts";
import cases from "./sensitive-cases.json" with { type: "json" };
import { tree } from "./fixtures.ts";

const edge = (from: string, to: string, kind: TopicEdge["kind"] = "part_of"): TopicEdge => ({ id: `edg_${from}_${to}`, from, to, kind, source: "placement", createdAt: "2026-10-01T00:00:00.000Z", deletedAt: null });

describe("sensitive categories", () => {
  it.each(cases as { text: string; category: string | null }[])("$text → $category", ({ text, category }) => {
    expect(isSensitive(text)).toBe(category);
  });
});

describe("hypothesis guards", () => {
  const t = tree({
    partOf: [["PPO", "RL"], ["RL", "ML"], ["Bandits", "RL"], ["Insulin dosing", "Medicine"]],
    claims: { PPO: 4 },
    hypotheses: { Bandits: { depth: 2, p: 0.5 } },
    confirmedHypotheses: { Medicine: 2 },
    life: ["Pets"],
  });
  const edges = [edge("PPO", "RL"), edge("RL", "ML"), edge("Bandits", "RL"), edge("Insulin dosing", "Medicine")];
  const check = (p: Partial<Parameters<typeof checkHypothesis>[1]>) => checkHypothesis(t, { nodeId: "RL", depth: 3, path: ["PPO", "RL"], reason: "PPO is part of RL", ...p }, edges);

  it("accepts a short path from something the person said", () => {
    expect(check({})).toBeNull();
    expect(check({ nodeId: "ML", depth: 2, path: ["PPO", "RL", "ML"] })).toBeNull();
  });

  it("rejects a node outside Knowledge", () => expect(check({ nodeId: "Pets", path: ["PPO", "Pets"] })).toMatch(/Knowledge/));
  it("rejects a depth outside 1–4", () => expect(check({ depth: 5 })).toMatch(/depth/));
  it("rejects an empty or over-long path", () => {
    expect(check({ path: [] })).toMatch(/path/);
    expect(check({ nodeId: "ML", path: ["PPO", "RL", "Bandits", "ML"] })).toMatch(/path/);
  });
  it("rejects a path that doesn't end at the node", () => expect(check({ path: ["PPO"] })).toMatch(/path/));
  it("rejects a path between nodes with no edge", () => expect(check({ nodeId: "ML", path: ["PPO", "ML"] })).toMatch(/edge/));
  it("rejects a path that starts at a guess", () => expect(check({ nodeId: "RL", path: ["Bandits", "RL"] })).toMatch(/established/));
  it("rejects a node the person already spoke to", () => expect(check({ nodeId: "PPO", path: ["PPO"] })).toMatch(/already/));
  it("rejects a node the person said they don't know, even with no gap recorded", () => {
    const said = tree({ partOf: [["PPO", "RL"]], claims: { PPO: 4 }, negatives: ["RL"] });
    expect(checkHypothesis(said, { nodeId: "RL", depth: 2, path: ["PPO", "RL"], reason: "r" }, [edge("PPO", "RL")])).toMatch(/already/);
  });

  it("rejects a sensitive node even when the path is sound", () => expect(check({ nodeId: "Insulin dosing", depth: 2, path: ["Medicine", "Insulin dosing"] })).toMatch(/health/));
});

import { describe, expect, it } from "vitest";
import { evalDedup, loadDedupCases, METHODS, type DedupCase } from "../src/index.ts";

const club = { name: "robotics club", kind: "org" as const };

const CASES: DedupCase[] = [
  {
    id: "shared-entity",
    existing: [
      { statement: "I led the robotics club's vision team.", entities: [club] },
      { statement: "I like poker.", entities: [] },
    ],
    candidate: { statement: "I headed computer vision for the robotics club.", entities: [club] },
    expect: 0,
  },
  {
    id: "no-entity",
    existing: [
      { statement: "I like poker.", entities: [] },
      { statement: "I prefer small teams.", entities: [] },
    ],
    candidate: { statement: "I prefer working in small teams.", entities: [] },
    expect: 1,
  },
  {
    id: "unrelated",
    existing: [{ statement: "I like poker.", entities: [] }],
    candidate: { statement: "My favorite city is Kyoto.", entities: [] },
    expect: null,
  },
];

describe("evalDedup", () => {
  it("reports recall@k per method", () => {
    const reports = evalDedup(CASES);
    expect(reports.map((r) => r.method)).toEqual(METHODS.map((m) => m.name));
    const entityOnly = reports.find((r) => r.method === "entity-only")!;
    expect(entityOnly.recall).toEqual({ 1: 0.5, 4: 0.5, 8: 0.5 });
    expect(entityOnly.misses).toEqual(["no-entity"]);
    const topk = reports.find((r) => r.method === "dice-topk+entity")!;
    expect(topk.recall[8]).toBe(1);
    expect(topk.avgCandidates).toBeGreaterThan(entityOnly.avgCandidates);
  });

  it("ships a labeled set whose expectations point at real memories", () => {
    const cases = loadDedupCases();
    expect(cases.length).toBeGreaterThanOrEqual(28);
    for (const c of cases) {
      if (c.expect !== null) expect(c.expect).toBeLessThan(c.existing.length);
      expect(c.existing.length).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
});

import { describe, expect, it } from "vitest";
import { computeConfidence } from "../src/confidence.ts";

const now = new Date("2026-10-01T00:00:00.000Z");
const base = { affirmed: false, isCurrentState: false, lastCorroboratedAt: now.toISOString(), now, halfLifeDays: 90 };

describe("computeConfidence", () => {
  it("combines sources with noisy-OR", () => {
    const c = computeConfidence({
      ...base,
      sources: [
        { sourceKind: "interview", authorRole: "self" },
        { sourceKind: "interview", authorRole: "self" },
      ],
    });
    expect(c).toBeCloseTo(1 - 0.1 * 0.1, 10);
  });

  it("discounts engaged sources", () => {
    const c = computeConfidence({ ...base, sources: [{ sourceKind: "slack", authorRole: "engaged" }] });
    expect(c).toBeCloseTo(0.49, 10);
  });

  it("treats AI memory as weak evidence", () => {
    const c = computeConfidence({ ...base, sources: [{ sourceKind: "chatgpt-memory", authorRole: "self" }] });
    expect(c).toBeCloseTo(0.4, 10);
  });

  it("gives affirmed memories full confidence", () => {
    expect(computeConfidence({ ...base, affirmed: true, sources: [] })).toBe(1);
  });

  it("decays current-state memories down to a floor of 0.25", () => {
    const old = new Date(now.getTime() - 180 * 86_400_000).toISOString();
    expect(computeConfidence({ ...base, affirmed: true, isCurrentState: true, lastCorroboratedAt: old, sources: [] })).toBe(0.25);
    const recent = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    expect(computeConfidence({ ...base, affirmed: true, isCurrentState: true, lastCorroboratedAt: recent, sources: [] })).toBeCloseTo(0.5, 10);
  });

  it("is zero with no sources and no affirmation", () => {
    expect(computeConfidence({ ...base, sources: [] })).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { salience } from "../src/index.ts";

describe("salience", () => {
  it("follows kindWeight × (0.5 + 0.5·confidence) × novelty × (1 + demand)", () => {
    expect(salience({ kind: "fact", confidence: 1, novelty: "new" })).toBe(1);
    expect(salience({ kind: "stance", confidence: 0, novelty: "new" })).toBeCloseTo(0.45, 10);
    expect(salience({ kind: "negative", confidence: 0.5, novelty: "update" })).toBeCloseTo(0.8 * 0.75 * 0.8, 10);
    expect(salience({ kind: "competence", confidence: 1, novelty: "contradiction", demandHits: 2 })).toBeCloseTo(3.6, 10);
  });
});

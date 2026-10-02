import { describe, expect, it } from "vitest";
import { bigrams, contentHash, dice, normalizeName } from "../src/text.ts";

describe("text utilities", () => {
  it("normalizes names across width, case and punctuation", () => {
    expect(normalizeName("ＧａｍｅＡＩ ")).toBe(normalizeName("gameai"));
    expect(normalizeName("Carnegie-Mellon  University")).toBe(normalizeName("carnegie mellon university"));
    expect(normalizeName("乔 林")).toBe("乔林");
  });

  it("scores CJK paraphrases as similar", () => {
    expect(dice("我喜欢扑克", "我很喜欢扑克")).toBeGreaterThan(0.5);
  });

  it("scores unrelated texts as zero", () => {
    expect(dice("I like poker", "我喜欢猫")).toBe(0);
  });

  it("handles single characters and empty strings", () => {
    expect(bigrams("猫")).toEqual(new Set(["猫"]));
    expect(dice("", "")).toBe(0);
  });

  it("hashes deterministically", () => {
    expect(contentHash("a", "b")).toBe(contentHash("a", "b"));
    expect(contentHash("a", "b")).not.toBe(contentHash("ab", ""));
  });
});

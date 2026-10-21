import { describe, expect, it } from "vitest";
import { gapStatement, statementFor } from "../src/index.ts";

describe("wording", () => {
  it("uses the approved templates", () => {
    expect([0, 1, 2, 3, 4].map((d) => statementFor(d, "Rust"))).toEqual([
      "Rust isn't something I know.",
      "I've heard of Rust but haven't used it.",
      "I've used Rust and can get things done with it.",
      "I know Rust well.",
      "Rust is one of my deep areas.",
    ]);
    expect(gapStatement("Rust macros", 1)).toBe("I'm fine with Rust macros up to 1, but not deeper.");
  });
});

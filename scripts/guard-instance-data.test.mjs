import { describe, expect, it } from "vitest";
import { findViolations } from "./guard-instance-data.mjs";

describe("findViolations", () => {
  it("flags instance data", () => {
    const bad = [
      "a/standin.db",
      "x.sqlite-wal",
      "notes.sqlite",
      ".standin/config.json",
      "home/.standin/standin.db",
      "data/observations.jsonl",
      "observations-2026.jsonl",
    ];
    expect(findViolations(bad)).toEqual(bad);
  });

  it("allows source and example fixtures", () => {
    const ok = [
      "examples/demo-persona/observations.jsonl",
      "packages/store/src/store.ts",
      "docs/specs/2026-10-01-standin-architecture.md",
    ];
    expect(findViolations(ok)).toEqual([]);
  });
});

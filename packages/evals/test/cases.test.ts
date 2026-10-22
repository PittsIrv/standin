import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSpeakPrompt } from "@standin/speak";
import { describe, expect, it } from "vitest";
import { readCases, repoCases, writeCases, type EvalCase } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

describe("case files", () => {
  it("reads good lines, names bad ones, and round-trips what it writes", () => {
    const file = join(tempDir(), "cases.jsonl");
    const good: EvalCase = { id: "known:mem_1", suite: "known", question: "Where do you study?", expect: { state: "grounded", mentions: ["Riverside"] } };
    writeFileSync(file, [JSON.stringify(good), "{not json", JSON.stringify({ ...good, id: "x", suite: "trivia" }), "", "  "].join("\n"));
    const { cases, errors } = readCases(file);
    expect(cases).toEqual([good]);
    expect(errors.map((e) => e.line)).toEqual([2, 3]);
    writeCases(file, cases);
    expect(readCases(file)).toEqual({ cases, errors: [] });
  });

  it("treats a missing file as no cases", () => {
    expect(readCases(join(tempDir(), "none.jsonl"))).toEqual({ cases: [], errors: [] });
  });

  it("ships a generic extraction suite and the demo suite", () => {
    expect(repoCases("extraction").every((c) => c.suite === "extraction" && c.expect.forbidden?.includes("cnry_"))).toBe(true);
    const system = buildSpeakPrompt({ personaName: "Lin", question: "q", seeds: [], items: [], exemplars: [], canary: "cnry_x", generalAllowed: false }).system.toLowerCase();
    for (const phrase of new Set(repoCases("extraction").flatMap((c) => c.expect.forbidden ?? []))) if (phrase !== "cnry_") expect(system).toContain(phrase);
    expect(new Set(repoCases("demo").map((c) => c.suite))).toEqual(new Set(["known", "not-on-record", "competence", "boundary"]));
  });
});

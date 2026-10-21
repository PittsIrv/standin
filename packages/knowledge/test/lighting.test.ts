import { describe, expect, it } from "vitest";
import { computeLighting } from "../src/index.ts";
import { tree } from "./fixtures.ts";

const at = (t: ReturnType<typeof tree>, node: string) => computeLighting(t).get(node);

describe("computeLighting", () => {
  it("lights a claim at its depth, with no cap", () => {
    expect(at(tree({ claims: { RLHF: 4 } }), "RLHF")).toMatchObject({ depth: 4, basis: "claimed", reasons: ["you claimed 4"] });
  });

  it("lights approved probed lighting and confirmed hypotheses as probed", () => {
    const t = tree({ approved: { Rust: { depth: 3, basis: "probed" } }, confirmedHypotheses: { Algorithms: 2 } });
    expect(at(t, "Rust")).toMatchObject({ depth: 3, basis: "probed" });
    expect(at(t, "Algorithms")).toMatchObject({ depth: 2, basis: "probed" });
  });

  it("no longer lights anything by inference: parts, prerequisites and backgrounds are hypotheses now", () => {
    const t = tree({ partOf: [["RLHF", "RL"]], requires: [["RLHF", "probability"]], claims: { RLHF: 4 }, seeded: { Algorithms: "I'm a CS student." } });
    for (const n of ["RL", "probability", "Algorithms"]) expect(at(t, n)).toBeUndefined();
  });

  it("leaves untouched nodes unlit", () => {
    expect(at(tree({ partOf: [["Graphics", "CS"]], claims: {} }), "Graphics")).toBeUndefined();
  });
});

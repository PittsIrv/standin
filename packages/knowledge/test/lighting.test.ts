import { describe, expect, it } from "vitest";
import { computeLighting } from "../src/index.ts";
import { tree } from "./fixtures.ts";

const at = (t: ReturnType<typeof tree>, node: string) => computeLighting(t).get(node);

describe("computeLighting", () => {
  it("lights a claim at its depth, with no cap", () => {
    expect(at(tree({ claims: { RLHF: 4 } }), "RLHF")).toMatchObject({ depth: 4, basis: "claimed", reasons: ["you claimed 4"] });
  });

  it("lights background core topics at 2", () => {
    expect(at(tree({ seeded: { Algorithms: "I'm a CS student at CMU." } }), "Algorithms")).toMatchObject({
      depth: 2,
      basis: "predicted",
      reasons: ["core of your background: I'm a CS student at CMU."],
    });
  });

  it("infers parents upward: min(child − 1, 3)", () => {
    const t = tree({ partOf: [["RLHF", "RL"], ["RL", "ML"]], claims: { RLHF: 4 } });
    expect(at(t, "RL")).toMatchObject({ depth: 3, basis: "predicted" });
    expect(at(t, "ML")).toMatchObject({ depth: 2, basis: "predicted" });
    expect(at(t, "RL")!.reasons[0]).toContain("RLHF");
  });

  it("infers prerequisites transitively, one level per hop", () => {
    const t = tree({ requires: [["RLHF", "probability"], ["probability", "calculus"]], claims: { RLHF: 4 } });
    expect(at(t, "probability")).toMatchObject({ depth: 3, basis: "predicted" });
    expect(at(t, "calculus")).toMatchObject({ depth: 2, basis: "predicted" });
  });

  it("raises a node above a lower claim when inference says so", () => {
    const t = tree({ partOf: [["RLHF", "ML"]], claims: { RLHF: 4, ML: 1 } });
    expect(at(t, "ML")).toMatchObject({ depth: 3, basis: "predicted" });
    expect(at(t, "ML")!.reasons).toEqual(["you claimed 1", "RLHF is at 4 and is part of it"]);
  });

  it("keeps a claim that beats the inference", () => {
    const t = tree({ partOf: [["RLHF", "RL"]], claims: { RLHF: 3, RL: 4 } });
    expect(at(t, "RL")).toMatchObject({ depth: 4, basis: "claimed" });
  });

  it("leaves untouched nodes dark", () => {
    const t = tree({ partOf: [["Graphics", "CS"]], claims: {} });
    expect(at(t, "Graphics")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { nextCardTarget, type TreeSnapshot } from "../src/index.ts";
import { tree } from "./fixtures.ts";

/** Parts with levels, marked expanded so the planner doesn't ask to expand them. */
function withParts(t: TreeSnapshot, parent: string, parts: Record<string, number>): TreeSnapshot {
  for (const [name, level] of Object.entries(parts)) {
    t.topics.set(name, { ...t.topics.get(name)!, partLevel: level });
    t.all.set(name, t.topics.get(name)!);
  }
  t.topics.set(parent, { ...t.topics.get(parent)!, expandedAt: "2026-10-01T00:00:00.000Z" });
  return t;
}
const none = () => ({ answered: new Set<string>(), guessesAnswered: new Set<string>() });
const RL = () => tree({ partOf: [["Rewards", "RL"], ["Policies", "RL"], ["Value functions", "RL"], ["Async RL", "RL"]] });
const RL_PARTS = { Rewards: 1, Policies: 2, "Value functions": 2, "Async RL": 4 };

describe("nextCardTarget", () => {
  it("asks guesses first, least sure first, then parts, then new areas", () => {
    const t = withParts(RL(), "RL", RL_PARTS);
    t.hypotheses.set("Algorithms", { id: "hyp_a", depth: 2, p: 0.9, kind: "background", rawScore: "medium", reason: "" });
    t.hypotheses.set("Systems", { id: "hyp_s", depth: 2, p: 0.55, kind: "background", rawScore: "medium", reason: "" });
    for (const n of ["Algorithms", "Systems"]) t.topics.set(n, { ...t.topics.get("RL")!, id: n, name: n, expandedAt: null, partLevel: null });
    t.stated.set("RL", 1);
    const s = none();
    expect(nextCardTarget(t, s, new Set())).toEqual({ kind: "guess", nodeId: "Systems", hypothesisId: "hyp_s" });
    s.guessesAnswered.add("hyp_s").add("hyp_a");
    expect(nextCardTarget(t, s, new Set())).toEqual({ kind: "part", nodeId: "Policies", parentId: "RL" });
  });

  it("asks only parts up to one level above a middle answer, and nothing below Expert or No", () => {
    const heard = withParts(RL(), "RL", RL_PARTS);
    heard.stated.set("RL", 1);
    const s = none();
    const asked: string[] = [];
    for (let target = nextCardTarget(heard, s, new Set()); target && typeof target !== "string" && target.kind === "part"; target = nextCardTarget(heard, s, new Set())) {
      asked.push(target.nodeId);
      s.answered.add(target.nodeId);
    }
    expect(asked).toEqual(["Policies", "Rewards", "Value functions"]);
    for (const level of [4, 0]) {
      const t = withParts(RL(), "RL", RL_PARTS);
      t.stated.set("RL", level);
      expect(nextCardTarget(t, none(), new Set())).toBeNull();
    }
  });

  it("asks nothing when fewer than two parts qualify or the walk was stopped, and expands an unexpanded start", () => {
    const few = withParts(tree({ partOf: [["Basics", "X"], ["Deep", "X"]] }), "X", { Basics: 1, Deep: 4 });
    few.stated.set("X", 1);
    expect(nextCardTarget(few, none(), new Set())).toBeNull();
    const stopped = withParts(RL(), "RL", RL_PARTS);
    stopped.stated.set("RL", 2);
    stopped.topics.set("RL", { ...stopped.topics.get("RL")!, walkStopped: true });
    expect(nextCardTarget(stopped, none(), new Set())).toBeNull();
    const fresh = tree({ stated: { Rust: 2 } });
    expect(nextCardTarget(fresh, none(), new Set())).toBe("expand:Rust");
    expect(nextCardTarget(fresh, none(), new Set(["expand:Rust"]))).toBeNull();
  });

  it("walks a claimed concept's parts without asking about the claim itself", () => {
    const t = withParts(RL(), "RL", RL_PARTS);
    t.claims.set("RL", 3);
    expect(nextCardTarget(t, none(), new Set())).toEqual({ kind: "part", nodeId: "Async RL", parentId: "RL" });
  });

  it("asks about untouched top-level areas last, and skips boundaries", () => {
    const t = tree({ partOf: [["Graphics", "CS"]] });
    expect(nextCardTarget(t, none(), new Set())).toEqual({ kind: "area", nodeId: "CS" });
    const walled = tree({ partOf: [["Graphics", "CS"]], boundaries: ["CS"] });
    expect(nextCardTarget(walled, none(), new Set())).toBeNull();
  });

  it("asks about areas from the person's background before the rest", () => {
    const t = tree({ partOf: [["Graphics", "Art"], ["Shaders", "Robotics"]], seeded: { Robotics: "I research robotics." } });
    expect(nextCardTarget(t, none(), new Set())).toEqual({ kind: "area", nodeId: "Robotics" });
  });
});

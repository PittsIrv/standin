import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { hypothesize } from "../src/index.ts";

const CFG = { dropBelow: 0.3, dropAfter: 10 };

function world() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-hyp-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const k = store.root("knowledge").id;
  const node = (name: string, parent: string) => {
    const n = store.ensureTopic(name);
    store.addEdge({ from: n.id, to: parent, kind: "part_of", source: "placement" });
    return n;
  };
  const ml = node("Machine learning", k);
  const rl = node("RL", ml.id);
  const ppo = node("PPO", rl.id);
  const medicine = node("Medicine", k);
  node("Insulin dosing", medicine.id);
  const claim = store.insertMemory(
    { kind: "competence", statement: "I know PPO deeply.", tier: 1, isCurrentState: false, attrs: { domain: "PPO", depth: 4 } },
    { sourceObservationIds: [o.id], entityIds: [ppo.id], actor: "compaction" },
  );
  store.approve(claim.id);
  return { store, ml, rl, ppo, medicine };
}

const say = (out: object) => new ScriptedLLM((req: GenerateObjectRequest<unknown>) => (req.purpose === "hypothesize" ? out : (() => { throw new Error(`unexpected ${req.purpose}`); })()));

describe("hypothesize", () => {
  it("adds sound guesses and rejects unknown nodes, guesses on guesses, sensitive topics and long paths, with reasons", async () => {
    const { store, rl } = world();
    const llm = say({
      hypotheses: [
        { node: "RL", depth: 3, rawScore: "high", kind: "part", path: ["PPO", "RL"], reason: "PPO is part of RL" },
        { node: "Quantum gravity", depth: 2, rawScore: "low", kind: "other", path: ["PPO", "Quantum gravity"], reason: "x" },
        { node: "Machine learning", depth: 2, rawScore: "medium", kind: "part", path: ["RL", "Machine learning"], reason: "RL is part of ML" },
        { node: "Insulin dosing", depth: 2, rawScore: "low", kind: "other", path: ["PPO", "Insulin dosing"], reason: "x" },
        { node: "Medicine", depth: 1, rawScore: "low", kind: "other", path: ["PPO", "RL", "Machine learning", "Medicine"], reason: "x" },
      ],
      withdraw: [],
    });
    const report = await hypothesize(store, llm, "Lin Qiao", CFG);
    expect(report.added).toBe(1);
    expect(store.listHypotheses({ status: "open" }).map((h) => [h.nodeId, h.depth, h.kind])).toEqual([[rl.id, 3, "part"]]);
    expect(report.rejected).toHaveLength(4);
    expect(report.rejected.join("\n")).toMatch(/Quantum gravity: unknown node/);
    expect(report.rejected.join("\n")).toMatch(/Machine learning: path must start at something established/);
    expect(report.rejected.join("\n")).toMatch(/Insulin dosing: (sensitive|no edge)/);
    expect(report.rejected.join("\n")).toMatch(/Medicine: path must/);
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain("PPO");
    expect(prompt).toContain("part:high");
  });

  it("replaces a guess whose depth changed and withdraws one the model drops", async () => {
    const { store, rl, ml } = world();
    await hypothesize(store, say({ hypotheses: [{ node: "RL", depth: 3, rawScore: "high", kind: "part", path: ["PPO", "RL"], reason: "r" }], withdraw: [] }), "Lin Qiao", CFG);
    store.setKv("hypothesize.lastRun", "2000-01-01T00:00:00.000Z");
    const report = await hypothesize(
      store,
      say({ hypotheses: [{ node: "RL", depth: 2, rawScore: "medium", kind: "part", path: ["PPO", "RL"], reason: "r" }], withdraw: ["Machine learning"] }),
      "Lin Qiao",
      CFG,
    );
    expect(report).toMatchObject({ added: 1, withdrawn: 1 });
    expect(store.listHypotheses({ status: "open" }).map((h) => [h.nodeId, h.depth])).toEqual([[rl.id, 2]]);
    expect(ml.id).toBeTruthy();
  });

  it("makes no call when nothing changed since the last run, or when nothing is established", async () => {
    const { store } = world();
    const llm = say({ hypotheses: [], withdraw: [] });
    await hypothesize(store, llm, "Lin Qiao", CFG);
    await hypothesize(store, llm, "Lin Qiao", CFG);
    expect(llm.calls).toHaveLength(1);
    const empty = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-hyp0-")), "db") });
    const idle = say({ hypotheses: [], withdraw: [] });
    expect(await hypothesize(empty, idle, "Lin Qiao", CFG)).toEqual({ added: 0, withdrawn: 0, rejected: [] });
    expect(idle.calls).toHaveLength(0);
  });

  it("drops guesses from an evidence cell that keeps failing", async () => {
    const { store } = world();
    store.setKv("priors", JSON.stringify({ "part:high": { a: 1, b: 20 } }));
    const llm = say({ hypotheses: [{ node: "RL", depth: 3, rawScore: "high", kind: "part", path: ["PPO", "RL"], reason: "r" }], withdraw: [] });
    const report = await hypothesize(store, llm, "Lin Qiao", { dropBelow: 0.3, dropAfter: 0 });
    expect(report.added).toBe(0);
    expect(report.rejected.join()).toMatch(/unreliable/);
  });
});

describe("hypothesize inside refresh", () => {
  it("turns a model failure into one warning and keeps going", async () => {
    const { refresh } = await import("../src/index.ts");
    const { Tracer, MemorySink } = await import("@standin/trace");
    const { store } = world();
    const down = new ScriptedLLM(() => {
      throw new Error("overloaded");
    });
    const map = new ScriptedLLM(() => ({ merges: [], placements: [], homes: [] }));
    const report = await refresh({ store, map, hypothesize: down, tracer: new Tracer({ sinks: [new MemorySink()] }), personaName: "Lin Qiao" });
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/^hypothesizing failed: .*overloaded/);
  });
});

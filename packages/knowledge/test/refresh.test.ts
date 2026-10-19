import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedLLM, type GenerateObjectRequest } from "@standin/llm";
import { TracedModel } from "@standin/models";
import { openStore } from "@standin/store";
import { MemorySink, Tracer } from "@standin/trace";
import { describe, expect, it } from "vitest";
import { answerMode, loadSnapshot, refresh } from "../src/index.ts";

const SEED = {
  field: { name: "Computer science", definition: "The study of computation." },
  core: ["Algorithms", "Systems", "Machine learning", "Theory of computation", "Software engineering"].map((name) => ({ name, definition: `${name}.` })),
};

function setup(handler: (req: GenerateObjectRequest<unknown>) => unknown) {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-know-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const approve = (kind: "fact" | "competence" | "negative", statement: string, attrs: object, topics: string[] = []) => {
    const m = store.insertMemory({ kind, statement, tier: 1, isCurrentState: false, attrs } as never, {
      sourceObservationIds: [o.id],
      entityIds: topics.map((t) => store.ensureTopic(t).id),
      actor: "compaction",
    });
    store.approve(m.id);
    return m;
  };
  const sink = new MemorySink();
  const tracer = new Tracer({ sinks: [sink] });
  const llm = new ScriptedLLM(handler);
  const map = new TracedModel(llm, { role: "map", tier: "large", tracer, prices: {} });
  return { store, approve, sink, tracer, map, llm, run: () => refresh({ store, map, tracer, personaName: "Lin Qiao" }) };
}

describe("refresh", () => {
  it("seeds from a background fact and proposes its core topics at 2", async () => {
    const t = setup((req) => (req.purpose === "seed" ? SEED : { merges: [], placements: [] }));
    t.approve("fact", "I'm a CS master's student at CMU.", { background: true });
    const report = await t.run();
    expect(report.seeded).toEqual(["Computer science"]);
    // 5 core topics at 2, plus the field at 1 by upward inference (a parent is at least one below its strongest child).
    expect(report.proposed).toBe(6);
    expect(t.store.listMemories({ status: "proposed" }).map((m) => m.statement)).toContain("I've heard of Computer science but haven't used it.");
    const names = t.store.listMemories({ status: "proposed" }).map((m) => m.statement);
    expect(names).toContain("I've used Algorithms and can get things done with it.");
    expect((await t.run()).proposed).toBe(0);
    expect(t.llm.calls.filter((c) => c.purpose === "seed")).toHaveLength(1);
  });

  it("places new topics, merges duplicates, and moves a claim with its merge", async () => {
    const t = setup((req) =>
      req.purpose === "place"
        ? {
            merges: [{ from: "RL", into: "reinforcement learning" }],
            placements: [
              { topic: "Rust macros", parent: "Rust", parentDefinition: null, definition: "Code that writes code in Rust." },
              { topic: "Rust", parent: "Programming languages", parentDefinition: "Languages for writing software.", definition: "A systems language." },
            ],
          }
        : SEED,
    );
    t.store.ensureTopic("reinforcement learning");
    t.approve("competence", "I know RL well.", { domain: "RL", depth: 3 }, ["RL"]);
    t.approve("competence", "I know Rust well.", { domain: "Rust", depth: 3 }, ["Rust"]);
    t.approve("negative", "I can't write Rust macros yet.", {}, ["Rust macros"]);
    const report = await t.run();
    expect(report).toMatchObject({ merged: 1, placed: 2, gaps: 1, refused: [] });
    const snap = loadSnapshot(t.store);
    const id = (name: string) => t.store.listTopics().find((x) => x.name === name)!.id;
    expect(answerMode(snap, id("reinforcement learning"))).toMatchObject({ mode: "explain", depth: 3 });
    expect(answerMode(snap, id("Rust macros"))).toMatchObject({ mode: "decline", from: { via: "gap" } });
    expect(t.store.getTopic(id("Rust")).definition).toBe("A systems language.");
  });

  it("refuses a placement that would make a cycle and keeps going", async () => {
    const t = setup((req) =>
      req.purpose === "place" ? { merges: [], placements: [{ topic: "B", parent: "A", parentDefinition: null, definition: "B." }] } : SEED,
    );
    const a = t.store.ensureTopic("A");
    const b = t.store.ensureTopic("B");
    t.store.addEdge({ from: a.id, to: b.id, kind: "part_of", source: "placement" });
    t.approve("competence", "I know B.", { domain: "B", depth: 2 }, ["B"]);
    t.store.listEdges(); // B has a child, so it's placed only if the model says so; it does, under its own child
    const report = await t.run();
    expect(report.refused).toEqual(["B"]);
  });

  it("still finds gaps and proposes when the map model fails", async () => {
    const t = setup(() => {
      throw new Error("overloaded");
    });
    const rust = t.store.ensureTopic("Rust");
    const macros = t.store.ensureTopic("Rust macros");
    t.store.addEdge({ from: macros.id, to: rust.id, kind: "part_of", source: "placement" });
    t.approve("fact", "I'm a CS student.", { background: true });
    t.approve("competence", "I know Rust well.", { domain: "Rust", depth: 3 }, ["Rust"]);
    t.approve("negative", "I can't write Rust macros yet.", {}, ["Rust macros"]);
    const report = await t.run();
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings[0]).toContain("overloaded");
    expect(report.gaps).toBe(1);
  });

  it("records the refresh as a map-refresh run with map model spans", async () => {
    const t = setup((req) => (req.purpose === "seed" ? SEED : { merges: [], placements: [] }));
    t.approve("fact", "I'm a CS student.", { background: true });
    await t.run();
    const spans = t.sink.spans.map((s) => s.span);
    const root = spans.find((s) => s.parentSpanId === null)!;
    expect(root.attributes["standin.run.kind"]).toBe("map-refresh");
    expect(spans.filter((s) => s.attributes["standin.role"] === "map").length).toBeGreaterThanOrEqual(1);
  });
});

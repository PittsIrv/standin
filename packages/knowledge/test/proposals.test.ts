import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { computeLighting, gapStatement, loadSnapshot, proposeLighting, statementFor } from "../src/index.ts";

function setup() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-know-")), "db") });
  const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
  const background = store.insertMemory(
    { kind: "fact", statement: "I'm a CS student at CMU.", tier: 1, isCurrentState: false, attrs: { background: true } },
    { sourceObservationIds: [o.id], entityIds: [], actor: "compaction" },
  );
  store.approve(background.id);
  const algorithms = store.ensureTopic("Algorithms");
  store.setTopic(algorithms.id, { seedMemoryId: background.id });
  const claim = (topic: string, depth: number) => {
    const node = store.ensureTopic(topic);
    const m = store.insertMemory(
      { kind: "competence", statement: `I know ${topic}.`, tier: 1, isCurrentState: false, attrs: { domain: topic, depth } },
      { sourceObservationIds: [o.id], entityIds: [node.id], actor: "compaction" },
    );
    store.approve(m.id);
    return { node, m };
  };
  return { store, algorithms, claim };
}

const refresh = (store: Store) => {
  const t = loadSnapshot(store);
  return proposeLighting(store, t, computeLighting(t));
};
const proposals = (store: Store) => store.listMemories({ status: "proposed", kind: "competence" });

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

describe("proposeLighting", () => {
  it("proposes a seeded node's lighting in the person's voice, with its reasons", () => {
    const { store, algorithms } = setup();
    const report = refresh(store);
    expect(report.proposed).toHaveLength(1);
    const [p] = proposals(store);
    expect(p).toMatchObject({
      statement: "I've used Algorithms and can get things done with it.",
      attrs: { domain: "Algorithms", depth: 2, basis: "predicted", reasons: ["core of your background: I'm a CS student at CMU."] },
    });
    expect(store.memoryEntities(p!.id).map((e) => e.id)).toEqual([algorithms.id]);
    expect(store.memoryEvents(p!.id)[0]!.actor).toBe("map");
  });

  it("proposes once, and never re-proposes a rejection", () => {
    const { store } = setup();
    refresh(store);
    expect(refresh(store).proposed).toEqual([]);
    store.reject(proposals(store)[0]!.id);
    expect(refresh(store).proposed).toEqual([]);
  });

  it("replaces a pending proposal when new evidence changes the value", () => {
    const { store, algorithms, claim } = setup();
    refresh(store);
    const stale = proposals(store)[0]!;
    const dp = store.ensureTopic("dynamic programming");
    store.addEdge({ from: dp.id, to: algorithms.id, kind: "part_of", source: "placement" });
    claim("dynamic programming", 4);
    const report = refresh(store);
    expect(report.replaced).toEqual([stale.id]);
    expect(store.getMemory(stale.id).status).toBe("rejected");
    expect(store.memoryEvents(stale.id).at(-1)).toMatchObject({ actor: "map", note: "replaced by a newer estimate" });
    expect(proposals(store).map((p) => p.kind === "competence" && p.attrs.depth)).toEqual([3]);
  });

  it("never proposes for a node's own claim, and approval supersedes the earlier lighting", () => {
    const { store, claim } = setup();
    const { m: mlClaim, node: ml } = claim("ML", 1);
    const rlhf = store.ensureTopic("RLHF");
    store.addEdge({ from: rlhf.id, to: ml.id, kind: "part_of", source: "placement" });
    claim("RLHF", 4);
    refresh(store);
    const mlProposal = proposals(store).find((p) => p.kind === "competence" && p.attrs.domain === "ML")!;
    expect(mlProposal).toMatchObject({ supersedesId: mlClaim.id, attrs: { depth: 3 } });
    expect(proposals(store).filter((p) => p.kind === "competence" && p.attrs.domain === "RLHF")).toEqual([]);
    store.approve(mlProposal.id);
    expect(store.getMemory(mlClaim.id).status).toBe("superseded");
    expect(refresh(store).proposed).toEqual([]);
  });
});

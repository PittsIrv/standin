import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { answerMode, loadSnapshot, syncStatedGaps } from "../src/index.ts";
import { tree } from "./fixtures.ts";

describe("answerMode", () => {
  it("maps depth to a mode", () => {
    const t = tree({ claims: { a: 0, b: 1, c: 2, d: 3, e: 4 } });
    expect(["a", "b", "c", "d", "e"].map((n) => answerMode(t, n).mode)).toEqual(["decline", "decline", "brief", "explain", "explain"]);
  });

  it("declines dark and unknown nodes", () => {
    const t = tree({ partOf: [["Graphics", "CS"]] });
    expect(answerMode(t, "Graphics")).toMatchObject({ mode: "decline", depth: null, from: null });
    expect(answerMode(t, null).mode).toBe("decline");
    expect(answerMode(t, "not in the tree").mode).toBe("decline");
  });

  it("inherits the nearest ancestor's approved lighting, of any basis", () => {
    const t = tree({
      partOf: [["replication", "distributed systems"], ["dynamic programming", "Algorithms"]],
      claims: { "distributed systems": 3 },
      approved: { Algorithms: { depth: 2, basis: "predicted" } },
    });
    expect(answerMode(t, "replication")).toMatchObject({ mode: "explain", depth: 3, from: { nodeId: "distributed systems", via: "inherited" } });
    expect(answerMode(t, "dynamic programming")).toMatchObject({ mode: "brief", depth: 2, from: { via: "inherited" } });
  });

  it("lets a gap carve its branch out of a lit node", () => {
    const t = tree({
      partOf: [["macros", "Rust"], ["proc macros", "macros"], ["ownership", "Rust"]],
      claims: { Rust: 3 },
      gaps: [{ node: "macros", level: 1 }],
    });
    expect(answerMode(t, "macros")).toMatchObject({ mode: "decline", depth: 1, from: { nodeId: "macros", via: "gap" } });
    expect(answerMode(t, "proc macros")).toMatchObject({ mode: "decline", from: { via: "gap" } });
    expect(answerMode(t, "ownership").mode).toBe("explain");
  });

  it("reports a boundary on the node or an ancestor", () => {
    const t = tree({ partOf: [["surgery", "health"]], claims: { health: 3 }, boundaries: ["health"] });
    expect(answerMode(t, "surgery").boundary).toBe(true);
    expect(answerMode(tree({ claims: { x: 3 } }), "x").boundary).toBe(false);
  });
});

describe("syncStatedGaps", () => {
  function setup() {
    const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-know-")), "db") });
    const rust = store.ensureTopic("Rust");
    const macros = store.ensureTopic("Rust macros");
    const knitting = store.ensureTopic("knitting");
    store.addEdge({ from: macros.id, to: rust.id, kind: "part_of", source: "placement" });
    const o = store.addObservation({ sourceKind: "interview", sourceRef: "i", authorRole: "self", text: "seed", occurredAt: "2026-09-01T00:00:00.000Z" });
    const ins = (kind: "competence" | "negative", statement: string, attrs: object, topic: string) => {
      const m = store.insertMemory({ kind, statement, tier: 1, isCurrentState: false, attrs } as never, { sourceObservationIds: [o.id], entityIds: [topic], actor: "compaction" });
      store.approve(m.id);
      return m;
    };
    ins("competence", "I know Rust well.", { domain: "Rust", depth: 3 }, rust.id);
    const cant = ins("negative", "I can't write Rust macros yet.", {}, macros.id);
    ins("negative", "I've never knitted.", {}, knitting.id);
    return { store, rust, macros, cant };
  }

  it("turns an approved negative under a lit node into a kept gap at 1, once", () => {
    const { store, rust, macros, cant } = setup();
    const created = syncStatedGaps(store, loadSnapshot(store));
    expect(created).toEqual([expect.objectContaining({ nodeId: macros.id, claimNodeId: rust.id, level: 1, status: "kept", source: "stated", memoryId: cant.id })]);
    expect(syncStatedGaps(store, loadSnapshot(store))).toEqual([]);
    expect(answerMode(loadSnapshot(store), macros.id).mode).toBe("decline");
  });

  it("leaves a negative with no lit ancestor alone", () => {
    const { store } = setup();
    const created = syncStatedGaps(store, loadSnapshot(store));
    expect(created.map((g) => store.getTopic(g.nodeId).name)).toEqual(["Rust macros"]);
  });
});

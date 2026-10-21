import { describe, expect, it } from "vitest";
import { calibration, loadSnapshot } from "../src/index.ts";
import { world } from "./session-helpers.ts";

/** Shows and rates a held-out probe on `topic`, with the standin's prediction `mode`. */
function answered(w: ReturnType<typeof world>, topic: string, holdout: "none" | "fixed" | "rotating", mode: "explain" | "brief" | "decline", rating: "know" | "roughly" | "no_idea" | "wouldnt_say" | null) {
  const node = w.store.ensureTopic(topic);
  const session = w.store.listSessions().at(-1) ?? w.store.startSession(10);
  const probe = w.store.insertProbe({ nodeId: node.id, checkOf: null, kind: "foundation", difficulty: 2, question: `${topic}?`, holdout });
  const r = w.store.showProbe(probe.id, session.id, mode);
  if (rating) w.store.rateResponse(r.id, rating, false);
  return node;
}

describe("calibration", () => {
  it("scores held-out answers against the stored prediction, per set", () => {
    const w = world();
    answered(w, "a", "fixed", "explain", "know");
    answered(w, "b", "fixed", "brief", "roughly");
    answered(w, "c", "fixed", "decline", "no_idea");
    answered(w, "d", "fixed", "explain", "no_idea");
    answered(w, "e", "rotating", "decline", "know");
    answered(w, "f", "fixed", "explain", "wouldnt_say");
    answered(w, "g", "fixed", "explain", null);
    answered(w, "h", "none", "explain", "know");
    const c = calibration(w.store, loadSnapshot(w.store));
    expect(c.map).toEqual({ fixed: { n: 4, agree: 3, score: 0.75 }, rotating: { n: 1, agree: 0, score: 0 } });
    expect(c.presented).toEqual(c.map);
  });

  it("leaves kept branches out of the map score but not the presented score", () => {
    const w = world();
    const rust = w.store.ensureTopic("Rust");
    const macros = answered(w, "Rust macros", "fixed", "explain", "no_idea");
    w.store.addEdge({ from: macros.id, to: rust.id, kind: "part_of", source: "placement" });
    w.store.addGap({ nodeId: macros.id, claimNodeId: rust.id, level: 1, status: "kept", source: "stated", memoryId: null });
    const c = calibration(w.store, loadSnapshot(w.store));
    expect(c.map.fixed).toEqual({ n: 0, agree: 0, score: null });
    expect(c.presented.fixed).toEqual({ n: 1, agree: 0, score: 0 });
  });

  it("still counts held-out answers about a node that was later deleted", () => {
    const w = world();
    const gone = answered(w, "gone", "fixed", "decline", "no_idea");
    w.store.setTopic(gone.id, { deletedAt: w.store.nowIso() });
    expect(calibration(w.store, loadSnapshot(w.store)).map.fixed).toEqual({ n: 1, agree: 1, score: 1 });
  });
});

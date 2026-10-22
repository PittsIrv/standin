import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "@standin/store";
import { describe, expect, it } from "vitest";
import { clearPriors, loadPriors, outcomeRecords, setPriors } from "../src/index.ts";

const store = () => openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-outcomes-")), "db") });
/** A guess on a node, answered on a card at `level` and settled. */
const settled = (s: Store, name: string, depth: number, level: number, path: string[] = []) => {
  const n = s.ensureTopic(name);
  const h = s.insertHypothesis({ nodeId: n.id, depth, rawScore: "medium", kind: "job", path: [...path, n.id], reason: "r" });
  const ses = s.startSession(0);
  const p = s.insertProbe({ nodeId: n.id, checkOf: null, kind: "card", difficulty: 1, question: name, holdout: "none", hypothesisId: h.id });
  s.answerCard(s.showProbe(p.id, ses.id, "brief").id, level);
  s.settleHypothesis(h.id);
  return h;
};

describe("outcome records", () => {
  it("are text-free: one per settled guess, with nothing that names a person, a topic or a time", () => {
    const s = store();
    settled(s, "Reinforcement learning", 3, 4);
    const ml = s.ensureTopic("Machine learning");
    settled(s, "Bandits", 2, 0, [ml.id]);
    s.insertHypothesis({ nodeId: s.ensureTopic("Open guess").id, depth: 2, rawScore: "low", kind: "course", path: [s.ensureTopic("Open guess").id], reason: "r" });
    expect(outcomeRecords(s)).toEqual([
      { evidenceKind: "job", rawScore: "medium", hops: 0, startDepth: null, hypothesizedDepth: 3, outcome: "confirmed" },
      { evidenceKind: "job", rawScore: "medium", hops: 1, startDepth: null, hypothesizedDepth: 2, outcome: "refuted" },
    ]);
  });
});

describe("default reliabilities", () => {
  it("are scaled down to the cap, kept, and can be cleared", () => {
    const s = store();
    expect(setPriors(s, { "job:medium": { a: 30, b: 10 }, "course:low": { a: 2, b: 3 } }, 10)).toEqual({ "job:medium": { a: 7.5, b: 2.5 }, "course:low": { a: 2, b: 3 } });
    expect(loadPriors(s)).toEqual({ "job:medium": { a: 7.5, b: 2.5 }, "course:low": { a: 2, b: 3 } });
    clearPriors(s);
    expect(loadPriors(s)).toBeUndefined();
  });

  it("refuses a file that isn't cells of positive counts for known kinds", () => {
    const s = store();
    expect(() => setPriors(s, { "job:medium": { a: -1, b: 2 } }, 10)).toThrow(/positive/);
    expect(() => setPriors(s, { "astrology:high": { a: 1, b: 1 } }, 10)).toThrow(/astrology:high/);
    expect(() => setPriors(s, [1, 2], 10)).toThrow();
    expect(loadPriors(s)).toBeUndefined();
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceKind, Holdout, Rating, RawScore } from "@standin/schema";
import { openStore } from "@standin/store";
import { describe, expect, it } from "vitest";
import { cells, outcomeOf, probabilityOf, safeguard } from "../src/index.ts";

function world() {
  const store = openStore({ path: join(mkdtempSync(join(tmpdir(), "standin-cal-")), "db") });
  const session = store.startSession(50);
  let i = 0;
  /** A hypothesis with one answered probe per rating; returns it. */
  const tested = (
    o: { kind?: EvidenceKind; raw?: RawScore; depth?: number; holdout?: Holdout; release?: boolean; grade?: "pass" | "fail"; p?: [number, number] },
    ...ratings: Rating[]
  ) => {
    const node = store.ensureTopic(`T${++i}`);
    const h = store.insertHypothesis({ nodeId: node.id, depth: o.depth ?? 2, rawScore: o.raw ?? "medium", kind: o.kind ?? "part", path: [node.id], reason: "r" });
    for (const rating of ratings) {
      const probe = store.insertProbe({ nodeId: node.id, checkOf: null, kind: "hypothesis", difficulty: o.depth ?? 2, question: `Q${i}?`, holdout: o.holdout ?? "none", hypothesisId: h.id });
      const r = store.showProbe(probe.id, session.id, "decline", o.p ? { predictedP: o.p[0], priorP: o.p[1] } : undefined);
      store.rateResponse(r.id, rating, o.grade !== undefined);
      if (o.grade) {
        store.recordGrade(r.id, o.grade, "g");
      }
    }
    if (o.release) store.releaseRotating([session.id]);
    return store.getHypothesis(h.id);
  };
  return { store, tested };
}

describe("outcomes", () => {
  it("confirms on know or roughly, refutes on no idea or a failed spot-check", () => {
    const { store, tested } = world();
    const rs = () => store.listResponses();
    expect(outcomeOf(tested({}, "roughly"), rs())).toBe("confirmed");
    expect(outcomeOf(tested({}, "no_idea"), rs())).toBe("refuted");
    expect(outcomeOf(tested({ grade: "fail" }, "know"), rs())).toBe("refuted");
    expect(outcomeOf(tested({}, "wouldnt_say"), rs())).toBeNull();
  });

  it("needs two confirmations at depth 4, but one refutation is enough", () => {
    const { store, tested } = world();
    const rs = () => store.listResponses();
    expect(outcomeOf(tested({ depth: 4 }, "know"), rs())).toBeNull();
    expect(outcomeOf(tested({ depth: 4 }, "know", "know"), rs())).toBe("confirmed");
    expect(outcomeOf(tested({ depth: 4 }, "no_idea"), rs())).toBe("refuted");
  });

  it("ignores held-out answers until a rotating one is released, and fixed ones forever", () => {
    const { store, tested } = world();
    const rs = () => store.listResponses();
    expect(outcomeOf(tested({ holdout: "fixed" }, "know"), rs())).toBeNull();
    const rotating = tested({ holdout: "rotating" }, "know");
    expect(outcomeOf(rotating, rs())).toBeNull();
    store.releaseRotating([store.listSessions()[0]!.id]);
    expect(outcomeOf(rotating, rs())).toBe("confirmed");
  });
});

describe("reliability cells", () => {
  it("has all fifteen cells at 0.5 when nothing is known", () => {
    const { store } = world();
    const c = cells(store);
    expect(c.size).toBe(15);
    expect([...c.values()].every((x) => x.p === 0.5 && x.confirmed === 0)).toBe(true);
  });

  it("counts settled outcomes per kind and score, and applies priors", () => {
    const { store, tested } = world();
    for (const r of ["know", "know", "know", "no_idea"] as const) store.settleHypothesis(tested({ kind: "background", raw: "high" }, r).id);
    store.settleHypothesis(tested({ kind: "prerequisite", raw: "low" }, "no_idea").id);
    const c = cells(store);
    expect(c.get("background:high")).toMatchObject({ confirmed: 3, refuted: 1, p: 4 / 6 });
    expect(c.get("prerequisite:low")).toMatchObject({ confirmed: 0, refuted: 1, p: 1 / 3 });
    expect(cells(store, { "prerequisite:low": { a: 9, b: 1 } }).get("prerequisite:low")!.p).toBe(9 / 11);
    const h = tested({ kind: "background", raw: "high" });
    expect(probabilityOf(h, c, { safeguard: false })).toBe(4 / 6);
    expect(probabilityOf(h, c, { safeguard: true })).toBe(0.5);
  });
});

describe("the Brier safeguard", () => {
  it("trips when calibrated predictions scored worse than prior-only ones on held-out answers", () => {
    const { store, tested } = world();
    // Calibrated said 0.9 every time; half were refuted. Prior said 0.5.
    for (const r of ["know", "no_idea", "know", "no_idea"] as const) tested({ holdout: "fixed", p: [0.9, 0.5] }, r);
    tested({ holdout: "none", p: [0.9, 0.5] }, "no_idea");
    const s = safeguard(store, 20);
    expect(s).toMatchObject({ tripped: true, n: 4 });
    expect(s.calibrated).toBeCloseTo((0.01 + 0.81 + 0.01 + 0.81) / 4);
    expect(s.prior).toBeCloseTo(0.25);
  });

  it("stays off when calibrated predictions did better", () => {
    const { store, tested } = world();
    for (const r of ["know", "know", "know"] as const) tested({ holdout: "fixed", p: [0.9, 0.5] }, r);
    expect(safeguard(store, 20).tripped).toBe(false);
  });
});

import { EvidenceKind, RawScore, type Hypothesis, type Probe, type ProbeResponse } from "@standin/schema";
import type { Store } from "@standin/store";
import { usableProbe } from "../snapshot.ts";

type Answered = ProbeResponse & { probe: Probe };

/** Depth 4 needs two confirming answers (knowledge-map decision 37); one refutation settles any depth. */
const CONFIRMATIONS_AT_4 = 2;

/** One answer's verdict: know/roughly confirm unless a spot-check failed; no idea or a failed spot-check refute. */
function verdict(r: Answered): "confirmed" | "refuted" | null {
  if (r.rating === null || r.rating === "wouldnt_say") return null;
  if (r.rating === "no_idea" || r.grade === "fail") return "refuted";
  return "confirmed";
}

/**
 * A hypothesis's outcome, read from its usable answers: held-out ones count only once a rotating probe is released,
 * and fixed ones never. Read, not stored, so a spot-check graded later can still flip it.
 */
export function outcomeOf(h: Hypothesis, responses: Answered[]): "confirmed" | "refuted" | null {
  // A concept card settles a guess in one answer: the level given, against the level guessed.
  const card = responses.find((r) => r.probe.kind === "card" && r.probe.hypothesisId === h.id && r.level !== null);
  if (card) return card.level! >= h.depth ? "confirmed" : "refuted";
  const mine = responses.filter((r) => r.probe.hypothesisId === h.id && r.probe.kind !== "card" && usableProbe(r.probe));
  const verdicts = mine.map(verdict).filter((v) => v !== null);
  if (verdicts.includes("refuted")) return "refuted";
  const confirmations = verdicts.length;
  return confirmations >= (h.depth === 4 ? CONFIRMATIONS_AT_4 : 1) ? "confirmed" : null;
}

export interface Cell {
  confirmed: number;
  refuted: number;
  a: number;
  b: number;
  /** (confirmed + a) / (confirmed + refuted + a + b): the mean of a Beta distribution. */
  p: number;
}

export const cellKey = (kind: string, rawScore: string) => `${kind}:${rawScore}`;

/** Reliability per evidence kind × raw score: how often hypotheses like this one turned out true for this person. */
export function cells(store: Store, priors: Record<string, { a: number; b: number }> = {}): Map<string, Cell> {
  const out = new Map<string, Cell>();
  for (const kind of EvidenceKind.options)
    for (const raw of RawScore.options) {
      const prior = priors[cellKey(kind, raw)] ?? { a: 1, b: 1 };
      out.set(cellKey(kind, raw), { confirmed: 0, refuted: 0, a: prior.a, b: prior.b, p: 0 });
    }
  const responses = store.listResponses({ rated: true });
  for (const h of store.listHypotheses()) {
    if (h.status === "withdrawn") continue;
    const outcome = outcomeOf(h, responses);
    const c = out.get(cellKey(h.kind, h.rawScore));
    if (!outcome || !c) continue;
    if (outcome === "confirmed") c.confirmed++;
    else c.refuted++;
  }
  for (const c of out.values()) c.p = (c.confirmed + c.a) / (c.confirmed + c.refuted + c.a + c.b);
  return out;
}

/** The calibrated probability, or the prior alone while the safeguard is tripped. */
export function probabilityOf(h: Pick<Hypothesis, "kind" | "rawScore">, c: Map<string, Cell>, opts: { safeguard: boolean }): number {
  const cell = c.get(cellKey(h.kind, h.rawScore));
  if (!cell) return 0.5;
  return opts.safeguard ? cell.a / (cell.a + cell.b) : cell.p;
}

export interface Safeguard {
  tripped: boolean;
  /** Mean Brier score of the stored calibrated predictions, and of the prior-only ones. */
  calibrated: number | null;
  prior: number | null;
  n: number;
}

/**
 * Is learning helping? Over the last `window` held-out hypothesis answers, compare the calibrated probability stored
 * when each was shown against the prior-only one. If calibration scored worse, it is switched off until that changes.
 */
export function safeguard(store: Store, window: number): Safeguard {
  // Concept cards: every guess answer was predicted before it was shown, so all of them count (predict, then learn).
  // Older quiz probes counted only when held out.
  const cardVerdict = (r: Answered) => (r.level === null ? null : r.level >= store.getHypothesis(r.probe.hypothesisId!).depth ? "confirmed" : "refuted");
  const scored = store
    .listResponses({ rated: true })
    .filter((r) => r.predictedP !== null && r.priorP !== null && r.probe.hypothesisId !== null)
    .filter((r) => r.probe.kind === "card" || (r.probe.kind === "hypothesis" && r.probe.holdout !== "none"))
    .map((r) => ({ r, v: r.probe.kind === "card" ? cardVerdict(r) : verdict(r) }))
    .filter((x) => x.v !== null)
    .slice(-window);
  if (scored.length === 0) return { tripped: false, calibrated: null, prior: null, n: 0 };
  const brier = (pick: (r: Answered) => number) => scored.reduce((sum, { r, v }) => sum + (pick(r) - (v === "confirmed" ? 1 : 0)) ** 2, 0) / scored.length;
  const calibrated = brier((r) => r.predictedP!);
  const prior = brier((r) => r.priorP!);
  return { tripped: calibrated > prior, calibrated, prior, n: scored.length };
}

/** Default reliabilities loaded with `standin outcomes priors` (WT-3), if any. */
export function loadPriors(store: Store): Record<string, { a: number; b: number }> | undefined {
  const raw = store.getKv("priors");
  return raw ? (JSON.parse(raw) as Record<string, { a: number; b: number }>) : undefined;
}

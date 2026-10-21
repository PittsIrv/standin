import type { Store } from "@standin/store";
import { safeguard, type Safeguard } from "../hypotheses/calibrate.ts";

export interface MapScore {
  n: number;
  agree: number;
  /** agree / n, or null with no answers yet. */
  score: number | null;
}

/**
 * Predict, then learn (concept-cards spec §7): every card answer is scored against the prediction recorded before it
 * was shown. The map score asks whether the standin would have answered (brief or explain) exactly where the person
 * says they can (level 2 or more); the guess score is the Brier comparison behind the safeguard.
 */
export function cardScores(store: Store, brierWindow = 20): { map: MapScore; guesses: Safeguard } {
  let n = 0;
  let agree = 0;
  for (const r of store.listResponses({ rated: true })) {
    if (r.probe.kind !== "card" || r.level === null) continue;
    n++;
    if ((r.predictedMode !== "decline") === r.level >= 2) agree++;
  }
  return { map: { n, agree, score: n === 0 ? null : agree / n }, guesses: safeguard(store, brierWindow) };
}

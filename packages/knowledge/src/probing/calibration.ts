import type { Store } from "@standin/store";
import type { TreeSnapshot } from "../snapshot.ts";

export interface SetScore {
  n: number;
  agree: number;
  /** agree / n, or null with no answers yet. */
  score: number | null;
}

export interface Calibration {
  /** Outside branches where the person kept a claim: how well the map predicts them on its own. Public. */
  map: { fixed: SetScore; rotating: SetScore };
  /** Every held-out answer: includes where the person chose to present more than they rated. Private. */
  presented: { fixed: SetScore; rotating: SetScore };
}

const score = (n: number, agree: number): SetScore => ({ n, agree, score: n === 0 ? null : agree / n });

/**
 * Held-out probes scored against the prediction stored when each was shown (spec §6): "would answer"
 * (explain/brief) agrees with know/roughly, and decline agrees with no_idea. "Wouldn't say" is left out.
 */
export function calibration(store: Store, t: TreeSnapshot): Calibration {
  const keptRoots = new Set(t.gaps.filter((g) => g.status === "kept" && g.claimNodeId).map((g) => g.claimNodeId!));
  const inKeptBranch = (nodeId: string) => {
    const seen = new Set<string>();
    for (let n: string | undefined = nodeId; n !== undefined && !seen.has(n); n = t.parentOf.get(n)) {
      if (keptRoots.has(n)) return true;
      seen.add(n);
    }
    return false;
  };
  const tally = { map: { fixed: [0, 0], rotating: [0, 0] }, presented: { fixed: [0, 0], rotating: [0, 0] } };
  for (const r of store.listResponses({ rated: true })) {
    const set = r.probe.holdout;
    if (set === "none" || r.rating === "wouldnt_say" || r.rating === null) continue;
    const wouldAnswer = r.predictedMode !== "decline";
    const knows = r.rating === "know" || r.rating === "roughly";
    const agree = wouldAnswer === knows ? 1 : 0;
    tally.presented[set][0]!++;
    tally.presented[set][1]! += agree;
    if (!inKeptBranch(r.probe.nodeId)) {
      tally.map[set][0]!++;
      tally.map[set][1]! += agree;
    }
  }
  const out = (x: { fixed: number[]; rotating: number[] }) => ({ fixed: score(x.fixed[0]!, x.fixed[1]!), rotating: score(x.rotating[0]!, x.rotating[1]!) });
  return { map: out(tally.map), presented: out(tally.presented) };
}

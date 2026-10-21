import type { TreeSnapshot } from "./snapshot.ts";

export type AnswerMode = "explain" | "brief" | "decline";

export interface AnswerDecision {
  mode: AnswerMode;
  /** The effective depth, or null when nothing on the path is lit. */
  depth: number | null;
  /** Where the depth came from: the node's own lighting, an ancestor's (inheritance), a gap, or a hypothesis. */
  from: { nodeId: string; via: "own" | "inherited" | "gap" | "hypothesis" } | null;
  /** A tier-3 boundary on the node or an ancestor: the runtime deflects whatever the depth. */
  boundary: boolean;
}

export const modeFor = (depth: number | null): AnswerMode => (depth === null || depth <= 1 ? "decline" : depth === 2 ? "brief" : "explain");

/** The node and its ancestors, nearest first. */
function pathUp(t: TreeSnapshot, nodeId: string): string[] {
  const path: string[] = [];
  for (let n: string | undefined = nodeId; n !== undefined && !path.includes(n); n = t.parentOf.get(n)) path.push(n);
  return path;
}

/**
 * What the standin may say about a node. Walking up from the node, the first gap or lighting wins: a gap carves its
 * branch out of a lit ancestor, and lighting (approved, or a probe-confirmed hypothesis) covers the branch below it.
 * With nothing on record, a probable node at or above `speakAt` answers briefly. Otherwise: decline.
 */
/** A probable node is spoken (at most briefly) only at or above this probability, unless config says otherwise. */
export const SPEAK_AT = 0.8;

export function answerMode(t: TreeSnapshot, nodeId: string | null, opts: { speakAt?: number } = {}): AnswerDecision {
  if (nodeId === null || !t.topics.has(nodeId)) return { mode: "decline", depth: null, from: null, boundary: false };
  const path = pathUp(t, nodeId);
  const boundary = path.some((n) => t.topics.get(n)?.boundaryTier === 3);
  for (const n of path) {
    const gaps = t.gaps.filter((g) => g.nodeId === n);
    if (gaps.length > 0) {
      const depth = Math.min(...gaps.map((g) => g.level));
      return { mode: modeFor(depth), depth, from: { nodeId: n, via: "gap" }, boundary };
    }
    const lit = t.approved.get(n);
    if (lit) return { mode: modeFor(lit.depth), depth: lit.depth, from: { nodeId: n, via: n === nodeId ? "own" : "inherited" }, boundary };
    const confirmed = t.confirmedHypotheses.get(n);
    if (confirmed !== undefined) return { mode: modeFor(confirmed), depth: confirmed, from: { nodeId: n, via: n === nodeId ? "own" : "inherited" }, boundary };
  }
  // Nothing on record: a confident guess about this very node may be spoken, hedged and never more than briefly.
  const guess = t.hypotheses.get(nodeId);
  if (guess && guess.p >= (opts.speakAt ?? SPEAK_AT)) {
    const mode = modeFor(guess.depth) === "decline" ? "decline" : "brief";
    return { mode, depth: guess.depth, from: { nodeId, via: "hypothesis" }, boundary };
  }
  return { mode: "decline", depth: null, from: null, boundary };
}

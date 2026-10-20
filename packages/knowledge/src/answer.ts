import type { TreeSnapshot } from "./snapshot.ts";

export type AnswerMode = "explain" | "brief" | "decline";

export interface AnswerDecision {
  mode: AnswerMode;
  /** The effective depth, or null when nothing on the path is lit. */
  depth: number | null;
  /** Where the depth came from: the node's own lighting, an ancestor's (inheritance), or a gap. */
  from: { nodeId: string; via: "own" | "inherited" | "gap" } | null;
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
 * What the standin may say about a node. Walking up from the node, the first gap or approved lighting wins:
 * a gap carves its branch out of a lit ancestor, and any approved lighting covers the branch below it.
 * Dark, unknown, or no node at all: decline.
 */
export function answerMode(t: TreeSnapshot, nodeId: string | null): AnswerDecision {
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
  }
  return { mode: "decline", depth: null, from: null, boundary };
}

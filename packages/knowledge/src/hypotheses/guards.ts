import type { TopicEdge } from "@standin/schema";
import type { TreeSnapshot } from "../snapshot.ts";
import { isSensitive } from "./sensitive.ts";

/** Most hops a hypothesis may reach from what the person said or was probed on. */
export const MAX_HOPS = 2;

/**
 * Something the person said or was probed on: their own claim, probed lighting, a gap, a confirmed hypothesis, or a
 * field seeded from their background. An open hypothesis never counts, so guesses can't build on guesses.
 */
export function established(t: TreeSnapshot, nodeId: string): boolean {
  return (
    t.claims.has(nodeId) ||
    t.approved.get(nodeId)?.basis === "probed" ||
    t.gaps.some((g) => g.nodeId === nodeId) ||
    t.confirmedHypotheses.has(nodeId) ||
    t.stated.has(nodeId) ||
    t.seeded.has(nodeId)
  );
}

/** The person's own word on the node, for or against (including "I don't know X"): then there is nothing to guess. */
export function spokenFor(t: TreeSnapshot, nodeId: string): boolean {
  return (
    t.claims.has(nodeId) ||
    t.approved.get(nodeId)?.basis === "probed" ||
    t.gaps.some((g) => g.nodeId === nodeId) ||
    t.confirmedHypotheses.has(nodeId) ||
    t.stated.has(nodeId) ||
    t.negatives.some((n) => n.topicIds.includes(nodeId))
  );
}

/** Why a proposed hypothesis is refused (spec §4.2), or null when it may be recorded. `path` runs from an established node to `nodeId`. */
export function checkHypothesis(
  t: TreeSnapshot,
  p: { nodeId: string; depth: number; path: string[]; reason: string },
  edges: TopicEdge[],
): string | null {
  const name = t.all.get(p.nodeId)?.name ?? p.nodeId;
  if (!t.knowledge.has(p.nodeId)) return "not a Knowledge node";
  if (!Number.isInteger(p.depth) || p.depth < 1 || p.depth > 4) return "depth must be 1–4";
  if (p.path.length === 0 || p.path.length > MAX_HOPS + 1 || p.path.at(-1) !== p.nodeId) return `path must run from an established node to this one in at most ${MAX_HOPS} hops`;
  const linked = (a: string, b: string) => edges.some((e) => !e.deletedAt && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));
  for (let i = 1; i < p.path.length; i++) if (!linked(p.path[i - 1]!, p.path[i]!)) return "no edge between consecutive path nodes";
  const category = isSensitive(`${name} ${p.reason}`);
  if (category) return `sensitive: ${category}`;
  if (spokenFor(t, p.nodeId)) return "already known from the person or a probe";
  if (!established(t, p.path[0]!)) return "path must start at something established";
  return null;
}

import type { Probe, ProbeResponse } from "@standin/schema";
import type { TreeSnapshot } from "../snapshot.ts";

export type Target =
  | { kind: "followup"; nodeId: string; difficulty: number; checkOf: string | null; gapOf: string }
  | { kind: "claim"; nodeId: string; difficulty: number; checkOf: string }
  | { kind: "hypothesis"; nodeId: string; difficulty: number; hypothesisId: string };

export interface ProbeState {
  /** Every shown probe's response (rated or not), in show order. */
  responses: (ProbeResponse & { probe: Probe })[];
  /** part_of: parent → children. */
  children: Map<string, string[]>;
}

/** Claims probe this many different parts at the claimed depth. */
export const CLAIM_PROBES = 3;
const MAX_DIFFICULTY = 4;
/** Expert needs two passed spot-checks (knowledge-map decision 37), so a hypothesis at 4 is asked twice. */
const ASKS_AT_4 = 2;

const byName = (t: TreeSnapshot) => (a: string, b: string) => (t.topics.get(a)?.name ?? a).localeCompare(t.topics.get(b)?.name ?? b);
const targetKey = (kind: string, nodeId: string) => `${kind}:${nodeId}`;

/** Nodes the person kept a claim over: probing stops going deeper there. */
function keptRoots(t: TreeSnapshot): Set<string> {
  return new Set(t.gaps.filter((g) => g.status === "kept" && g.claimNodeId).map((g) => g.claimNodeId!));
}

function inKeptBranch(t: TreeSnapshot, nodeId: string, kept: Set<string>): boolean {
  const seen = new Set<string>();
  for (let n: string | undefined = nodeId; n !== undefined && !seen.has(n); n = t.parentOf.get(n)) {
    if (kept.has(n)) return true;
    seen.add(n);
  }
  return false;
}

/**
 * The next thing to probe, by strict priority: follow-ups for confirmed gaps, then claim checks, then open
 * hypotheses (most uncertain first). Returns `expand:<node>` when a claimed node needs its parts first, or null
 * when there is nothing left to ask. Pure: the session does the I/O.
 */
export function nextTarget(t: TreeSnapshot, s: ProbeState, skip: Set<string>): Target | `expand:${string}` | null {
  const live = (id: string) => t.topics.has(id);
  const kept = keptRoots(t);
  const shown = s.responses;
  const ok = (kind: string, nodeId: string) => live(nodeId) && !skip.has(targetKey(kind, nodeId));

  // 1. Follow-ups: a miss the person judged a gap gets one probe a level lower on the same node.
  // `responses` is in show order, so "after" is by position: timestamps can tie within a second.
  for (const [i, r] of shown.entries()) {
    if (r.judged !== "gap" || r.probe.difficulty < 2 || !ok("followup", r.probe.nodeId)) continue;
    const followed = shown
      .slice(i + 1)
      .some((f) => f.probe.kind === "followup" && f.probe.nodeId === r.probe.nodeId && f.probe.difficulty === r.probe.difficulty - 1);
    if (!followed) return { kind: "followup", nodeId: r.probe.nodeId, difficulty: r.probe.difficulty - 1, checkOf: r.probe.checkOf, gapOf: r.id };
  }

  // 2. Claim checks: CLAIM_PROBES probes on different parts of each claimed node, at the claimed depth.
  for (const claimNode of [...t.claims.keys()].filter(live).sort(byName(t))) {
    const depth = t.claims.get(claimNode)!;
    if (depth < 1 || kept.has(claimNode) || t.gaps.some((g) => g.claimNodeId === claimNode && g.status === "lowered")) continue;
    const asked = shown.filter((r) => r.probe.kind === "claim" && r.probe.checkOf === claimNode);
    if (asked.length >= CLAIM_PROBES) continue;
    const parts = (s.children.get(claimNode) ?? []).filter(live);
    if (parts.length < CLAIM_PROBES && !t.topics.get(claimNode)!.expandedAt && !skip.has(targetKey("expand", claimNode))) return `expand:${claimNode}`;
    const used = new Set(asked.map((r) => r.probe.nodeId));
    const pool = parts.length > 0 ? parts : [claimNode];
    const next = pool.sort(byName(t)).find((p) => !used.has(p) && ok("claim", p));
    if (next) return { kind: "claim", nodeId: next, difficulty: Math.min(depth, MAX_DIFFICULTY), checkOf: claimNode };
  }

  // 3. Hypotheses: the guesses we are least sure of first. Answers in the fixed held-out set never settle a guess,
  // so they don't count as asked.
  const asked = (hypothesisId: string) => shown.filter((r) => r.probe.hypothesisId === hypothesisId && r.probe.holdout !== "fixed");
  const open = [...t.hypotheses]
    .filter(([nodeId, h]) => {
      if (!ok("hypothesis", nodeId) || inKeptBranch(t, nodeId, kept)) return false;
      const answers = asked(h.id);
      if (answers.some((r) => r.rating === "no_idea" || r.rating === "wouldnt_say")) return false;
      return answers.length < (h.depth === MAX_DIFFICULTY ? ASKS_AT_4 : 1);
    })
    .sort(([a, x], [b, y]) => Math.abs(x.p - 0.5) - Math.abs(y.p - 0.5) || byName(t)(a, b));
  const [nodeId, h] = open[0] ?? [];
  return nodeId && h ? { kind: "hypothesis", nodeId, difficulty: h.depth, hypothesisId: h.id } : null;
}

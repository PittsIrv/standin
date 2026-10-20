import type { Probe, ProbeResponse } from "@standin/schema";
import { answerMode } from "../answer.ts";
import type { TreeSnapshot } from "../snapshot.ts";

export type Target =
  | { kind: "followup"; nodeId: string; difficulty: number; checkOf: string | null; gapOf: string }
  | { kind: "claim"; nodeId: string; difficulty: number; checkOf: string }
  | { kind: "foundation"; nodeId: string; difficulty: number }
  | { kind: "discovery"; nodeId: string; difficulty: number };

export interface ProbeState {
  /** Every shown probe's response (rated or not), in show order. */
  responses: (ProbeResponse & { probe: Probe })[];
  /** part_of: parent → children. */
  children: Map<string, string[]>;
}

/** Claims probe this many different parts at the claimed depth. */
export const CLAIM_PROBES = 3;
export const DISCOVERY_START = 2;
const MAX_DIFFICULTY = 4;

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
 * The next thing to probe, by strict priority: follow-ups for confirmed gaps, then claim checks, then
 * inferred lighting (foundations), then discovery. Returns `expand:<node>` when a node needs its parts first,
 * or null when there is nothing left to ask. Pure: the session does the I/O.
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

  // 3. Foundations: every node lit by inference gets one probe at its depth.
  for (const [nodeId, lit] of [...t.approved].sort(([a], [b]) => byName(t)(a, b))) {
    if (lit.basis !== "predicted" || lit.depth < 1 || inKeptBranch(t, nodeId, kept) || !ok("foundation", nodeId)) continue;
    if (!shown.some((r) => r.probe.kind === "foundation" && r.probe.nodeId === nodeId)) return { kind: "foundation", nodeId, difficulty: lit.depth };
  }

  // 4. Discovery: finish an open walk, else start one on a dark neighbour of a strong node.
  const walks = new Map<string, (ProbeResponse & { probe: Probe })[]>();
  for (const r of shown.filter((x) => x.probe.kind === "discovery")) walks.set(r.probe.nodeId, [...(walks.get(r.probe.nodeId) ?? []), r]);
  for (const [nodeId, steps] of walks) {
    const last = steps.at(-1)!;
    if (last.rating === "know" && last.probe.difficulty < MAX_DIFFICULTY && ok("discovery", nodeId))
      return { kind: "discovery", nodeId, difficulty: last.probe.difficulty + 1 };
  }
  // Strong = the node's own lighting is at least 3. Inherited lighting doesn't count: everything under a lit node
  // inherits it, so its parts are never dark and expanding them would never end.
  const strong = [...t.approved]
    .filter(([id, lit]) => live(id) && lit.depth >= 3 && !inKeptBranch(t, id, kept))
    .map(([id]) => id)
    .sort(byName(t));
  const candidates = new Set<string>();
  for (const id of strong) {
    const parent = t.parentOf.get(id);
    for (const c of s.children.get(id) ?? []) candidates.add(c);
    if (parent) for (const sib of s.children.get(parent) ?? []) candidates.add(sib);
    for (const [from, to] of t.requires) if (from === id) candidates.add(to);
  }
  const dark = [...candidates].filter((id) => live(id) && answerMode(t, id).depth === null && !walks.has(id) && ok("discovery", id)).sort(byName(t));
  if (dark[0]) return { kind: "discovery", nodeId: dark[0], difficulty: DISCOVERY_START };
  const unexpanded = strong.find((id) => !t.topics.get(id)!.expandedAt && !skip.has(targetKey("expand", id)));
  return unexpanded ? `expand:${unexpanded}` : null;
}

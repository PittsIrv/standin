import type { Store } from "@standin/store";
import type { TreeSnapshot } from "./snapshot.ts";
import { treeNodes, type TreeNode } from "./tree-view.ts";

/** Everything the review page's side panel shows about one node. */
export interface NodeDetail {
  node: TreeNode;
  definition: string | null;
  aliases: string[];
  /** Approved memories living in the node. */
  facts: { id: string; kind: string; statement: string; tier: number }[];
  /** The open guess, with its evidence path as node names. */
  hypothesis: { depth: number; p: number; kind: string; reason: string; path: string[] } | null;
  /** Probes asked about the node, oldest first. */
  history: { question: string; kind: string; difficulty: number; rating: string | null; level: number | null; grade: string | null; shownAt: string }[];
  links: { id: string; kind: "requires" | "related"; other: { id: string; name: string }; direction: "out" | "in" }[];
}

export function nodeDetail(store: Store, t: TreeSnapshot, nodeId: string): NodeDetail {
  const topic = store.getTopic(nodeId);
  const node = treeNodes(t, { all: true }).find((n) => n.id === nodeId)!;
  const name = (id: string) => (t.all.get(id) ?? store.getTopic(id)).name;
  const guess = t.hypotheses.get(nodeId);
  const path = guess ? store.getHypothesis(guess.id).path.map(name) : [];
  return {
    node,
    definition: topic.definition,
    aliases: topic.aliases,
    facts: store.nodeMemories(nodeId, { status: "approved" }).map((m) => ({ id: m.id, kind: m.kind, statement: m.statement, tier: m.tier })),
    hypothesis: guess ? { depth: guess.depth, p: guess.p, kind: guess.kind, reason: guess.reason, path } : null,
    history: store
      .listResponses()
      .filter((r) => r.probe.nodeId === nodeId)
      .map((r) => ({ question: r.probe.question, kind: r.probe.kind, difficulty: r.probe.difficulty, rating: r.rating, level: r.level, grade: r.grade, shownAt: r.shownAt })),
    links: store
      .listEdges()
      .filter((e) => e.kind !== "part_of" && (e.from === nodeId || e.to === nodeId))
      .map((e) => {
        const other = e.from === nodeId ? e.to : e.from;
        return { id: e.id, kind: e.kind as "requires" | "related", other: { id: other, name: name(other) }, direction: e.from === nodeId ? ("out" as const) : ("in" as const) };
      }),
  };
}

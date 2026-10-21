import { ROOTS, type EntityKind, type RootKey } from "@standin/schema";
import { answerMode } from "./answer.ts";
import type { TreeSnapshot } from "./snapshot.ts";

/** One node of the world tree as the CLI and the review page show it. */
export interface TreeNode {
  id: string;
  name: string;
  parent: string | null;
  parentId: string | null;
  root: RootKey | null;
  label: EntityKind;
  /** lit: known (Knowledge: depth ≥ 1; elsewhere: approved facts). dark: known not to. probable: a guess. unlit: none. */
  state: "lit" | "dark" | "probable" | "unlit";
  mode: string;
  depth: number | null;
  basis: string | null;
  via: "own" | "inherited" | "gap" | "hypothesis" | null;
  from: string | null;
  boundary: boolean;
  /** An inferred node a foundation probe confirmed. */
  confirmed: boolean;
  frontier: boolean;
  /** Approved memories living in the node. */
  facts: number;
  /** For a probable node: the open hypothesis and its calibrated probability. */
  p: number | null;
  hypothesis: { depth: number; p: number; kind: string; reason: string } | null;
}

/** Every live node (roots excluded); frontier nodes only with `all`. */
export function treeNodes(t: TreeSnapshot, opts: { all?: boolean } = {}): TreeNode[] {
  const name = (id: string) => t.all.get(id)?.name ?? ROOTS.find((r) => r.key === t.roots.get(id))?.name ?? id;
  return [...t.all.values()]
    .filter((n) => opts.all || !n.frontier)
    .map((n) => {
      const parentId = t.parentOf.get(n.id) ?? null;
      const knowledge = t.knowledge.has(n.id);
      const d = answerMode(t, n.id);
      const facts = t.homeFacts.get(n.id) ?? 0;
      const guess = t.hypotheses.get(n.id) ?? null;
      const state: TreeNode["state"] = knowledge
        ? d.depth === null || d.from?.via === "hypothesis"
          ? guess
            ? "probable"
            : "unlit"
          : d.depth === 0
            ? "dark"
            : "lit"
        : facts > 0
          ? "lit"
          : "unlit";
      return {
        id: n.id,
        name: n.name,
        parent: parentId ? name(parentId) : null,
        parentId,
        root: t.rootOf.get(n.id) ?? null,
        label: n.label,
        state,
        mode: d.mode,
        depth: d.depth,
        basis: !d.from
          ? null
          : d.from.via === "gap" || d.from.via === "hypothesis"
            ? d.from.via
            : (t.approved.get(d.from.nodeId)?.basis ?? (t.confirmedHypotheses.has(d.from.nodeId) ? "probed" : null)),
        via: d.from?.via ?? null,
        from: d.from ? name(d.from.nodeId) : null,
        boundary: d.boundary || n.boundaryTier === 3,
        confirmed: t.confirmed.has(n.id),
        frontier: n.frontier,
        facts,
        p: guess?.p ?? null,
        hypothesis: guess ? { depth: guess.depth, p: guess.p, kind: guess.kind, reason: guess.reason } : null,
      };
    });
}

/** One line of status for a node. */
export function nodeStatus(v: TreeNode): string {
  const knowledge = v.root === "knowledge" || (v.root === null && v.label === "topic");
  const lit = !knowledge
    ? `${v.facts} fact${v.facts === 1 ? "" : "s"}`
    : v.state === "probable" && v.hypothesis
      ? `probable ${v.hypothesis.depth} (p ${v.hypothesis.p.toFixed(2)}, ${v.hypothesis.kind})`
      : v.depth === null
      ? "not lit"
      : v.via === "gap"
        ? `gap: fine up to ${v.depth}`
        : v.depth === 0
          ? "dark"
          : v.via === "inherited"
            ? `lit ${v.depth} (inherited from ${v.from})`
            : `lit ${v.depth} (${v.basis}${v.confirmed ? ", confirmed" : ""})`;
  return [lit, v.boundary ? "boundary" : null, v.frontier ? "frontier" : null].filter(Boolean).join(" · ");
}

/** The six roots in order, each with its branch indented; nodes with no place yet come last. */
export function renderForest(t: TreeSnapshot, opts: { all?: boolean } = {}): string {
  const nodes = treeNodes(t, opts);
  const byId = new Map(nodes.map((v) => [v.id, v]));
  const children = new Map<string, TreeNode[]>();
  for (const v of nodes) if (v.parentId) children.set(v.parentId, [...(children.get(v.parentId) ?? []), v]);
  const lines: string[] = [];
  const walk = (v: TreeNode, depth: number) => {
    lines.push(`${"  ".repeat(depth)}${v.name}  ${nodeStatus(v)}`);
    for (const c of (children.get(v.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))) walk(c, depth + 1);
  };
  for (const r of ROOTS) {
    const rootId = [...t.roots].find(([, key]) => key === r.key)?.[0];
    lines.push(r.name);
    for (const c of (rootId ? (children.get(rootId) ?? []) : []).sort((a, b) => a.name.localeCompare(b.name))) walk(c, 1);
  }
  const loose = nodes.filter((v) => v.parentId === null || (!byId.has(v.parentId) && !t.roots.has(v.parentId)));
  const unplaced = loose.filter((v) => v.parentId === null && !children.has(v.id));
  const orphans = loose.filter((v) => !unplaced.includes(v));
  for (const v of orphans) walk(v, 0);
  if (unplaced.length > 0) lines.push("", "Not yet placed (run `standin map refresh`):", ...unplaced.map((v) => `  ${v.name}  ${nodeStatus(v)}`));
  return lines.join("\n");
}

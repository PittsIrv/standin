import { answerMode } from "../answer.ts";
import type { TreeSnapshot } from "../snapshot.ts";

/** A concept with fewer qualifying parts than this keeps the answer on the node: nothing below it is asked. */
export const MIN_PARTS = 2;
/** A part with no level of its own counts as working knowledge. */
const DEFAULT_PART_LEVEL = 2;

export type CardTarget =
  | { kind: "guess"; nodeId: string; hypothesisId: string }
  | { kind: "part"; nodeId: string; parentId: string }
  | { kind: "area"; nodeId: string };

export interface CardState {
  /** Nodes with any card answer (including "wouldn't say"). */
  answered: Set<string>;
  /** Hypotheses a card already asked about. */
  guessesAnswered: Set<string>;
}

const byName = (t: TreeSnapshot) => (a: string, b: string) => (t.topics.get(a)?.name ?? a).localeCompare(t.topics.get(b)?.name ?? b);

/**
 * The next concept card (concept-cards spec §3–§4), after any keep-or-lower card the session checks first:
 * guesses (least sure first), then the parts a middle answer opens up (depth-first), then untouched top-level areas.
 * Returns `expand:<node>` when a walk needs a concept's parts first, or null when nothing is left. Pure.
 */
export function nextCardTarget(t: TreeSnapshot, s: CardState, skip: Set<string>): CardTarget | `expand:${string}` | null {
  const children = new Map<string, string[]>();
  for (const [child, parent] of t.parentOf) if (t.topics.has(child)) children.set(parent, [...(children.get(parent) ?? []), child]);
  for (const list of children.values()) list.sort(byName(t));
  const walled = (id: string) => answerMode(t, id).boundary;
  const spoken = (id: string) => s.answered.has(id) || t.claims.has(id);

  // 1. Guesses, least sure first.
  const guess = [...t.hypotheses]
    .filter(([nodeId, h]) => !s.guessesAnswered.has(h.id) && !s.answered.has(nodeId) && !walled(nodeId) && !skip.has(`guess:${nodeId}`))
    .sort(([a, x], [b, y]) => Math.abs(x.p - 0.5) - Math.abs(y.p - 0.5) || byName(t)(a, b))[0];
  if (guess) return { kind: "guess", nodeId: guess[0], hypothesisId: guess[1].id };

  // 2. Parts: a middle answer (or a middle claim) walks the parts up to one level above it, depth-first.
  const tops = [...t.topics.keys()].filter((id) => !t.topics.has(t.parentOf.get(id) ?? "")).sort(byName(t));
  const walk = (id: string): CardTarget | `expand:${string}` | null => {
    const node = t.topics.get(id)!;
    // "That's enough here" stops the whole branch, as does a boundary.
    if (walled(id) || node.walkStopped) return null;
    const level = t.stated.get(id) ?? (s.answered.has(id) ? undefined : t.claims.get(id));
    if (level !== undefined && level >= 1 && level <= 3) {
      const qualifying = (children.get(id) ?? []).filter((c) => (t.topics.get(c)!.partLevel ?? DEFAULT_PART_LEVEL) <= level + 1);
      if (qualifying.length < MIN_PARTS) {
        if (!node.expandedAt && !skip.has(`expand:${id}`)) return `expand:${id}`;
      } else {
        const next = qualifying.find((c) => !spoken(c) && !walled(c) && !skip.has(`part:${c}`));
        if (next) return { kind: "part", nodeId: next, parentId: id };
      }
    }
    for (const c of children.get(id) ?? []) {
      const found = walk(c);
      if (found) return found;
    }
    return null;
  };
  for (const id of tops) {
    const found = walk(id);
    if (found) return found;
  }

  // 3. New areas: top-level concepts and seeded fields nobody has said anything about.
  const area = [...new Set([...tops, ...t.seeded.keys()])]
    .filter((id) => t.topics.has(id) && !spoken(id) && !t.stated.has(id) && !t.approved.has(id) && !t.hypotheses.has(id) && !walled(id) && !skip.has(`area:${id}`))
    .sort(byName(t))[0];
  return area ? { kind: "area", nodeId: area } : null;
}

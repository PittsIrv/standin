import type { Bundle, BundleAnswer, BundleMemory, BundleNode, MemoryKind, RootKey, Tier } from "@standin/schema";

/** Starting values (answering spec §10). */
export const LIMITS = { candidates: 10, seeds: 3, awakenBudget: 20, exemplars: 3, exemplarChars: 600 };
export type Limits = typeof LIMITS;

/** A memory the speaker may use. */
export interface ContextMemory {
  id: string;
  statement: string;
  kind: MemoryKind;
  tier: Tier;
  nodeId: string;
  nodeName: string;
}

export interface Seed {
  id: string;
  name: string;
  root: RootKey | null;
  /** Under the Knowledge root: the answering rule decides how much may be said. */
  knowledge: boolean;
  /** The answering rule's mode, for Knowledge seeds only. */
  mode: BundleAnswer["mode"] | null;
}

/** Why a memory in the bundle wasn't shown to the speaker. Everything else was filtered when the bundle was built. */
export type FilterReason = "expired" | "budget";

export interface Awakened {
  seeds: Seed[];
  memories: ContextMemory[];
  /** Confident guesses about a seed with nothing on record: spoken only hedged. */
  hypotheses: { nodeId: string; name: string; depth: number }[];
  filtered: { id: string; reason: FilterReason }[];
}

/** A bundle indexed for answering. Build it once per bundle; it never changes. */
export interface BundleView {
  bundle: Bundle;
  nodes: Map<string, BundleNode>;
  children: Map<string, string[]>;
  /** Memories living on or naming each node. */
  memoriesOf: Map<string, BundleMemory[]>;
  related: Map<string, string[]>;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
};

export function viewOf(bundle: Bundle): BundleView {
  const nodes = new Map(bundle.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const n of bundle.nodes) if (n.parent) push(children, n.parent, n.id);
  const memoriesOf = new Map<string, BundleMemory[]>();
  for (const m of bundle.memories) for (const id of m.nodes) push(memoriesOf, id, m);
  const related = new Map<string, string[]>();
  for (const [a, b] of bundle.related) {
    push(related, a, b);
    push(related, b, a);
  }
  return { bundle, nodes, children, memoriesOf, related };
}

// Words that say nothing about what a visitor is asking about.
const STOP = new Set(
  "a an and as at by for from in into of on or the to with i me my mine myself you your yours we our us it its is are was were be been being do does did doing have has had having what which who whom whose where when why how can could would should will shall may might must tell about please any some this that these those there here just also not no yes so if than then very really ever".split(
    " ",
  ),
);

/** Lower-case words of a question or a statement, a plural's "s" dropped, with nothing too short or too common. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => w.length > 1 && !STOP.has(w));
}

const live = (m: BundleMemory, now: string) => m.validUntil === null || m.validUntil > now;

/** The node and its ancestors in the bundle, nearest first. */
function pathUp(v: BundleView, id: string): string[] {
  const path: string[] = [];
  for (let at: string | null = id; at && !path.includes(at); at = v.nodes.get(at)?.parent ?? null) path.push(at);
  return path;
}

/**
 * The nodes a question may be about (answering spec §2, step 1): ranked by the words they share with it, rarer words
 * counting more. A word of the node's name or aliases counts double; its definition, examples and memories count once.
 */
export function candidates(v: BundleView, question: string, now: string, n = LIMITS.candidates): BundleNode[] {
  const asked = new Set(terms(question));
  if (asked.size === 0) return [];
  const bags = v.bundle.nodes.map((t) => {
    const name = new Set(terms([t.name, ...t.aliases].join(" ")));
    const seen = (v.memoriesOf.get(t.id) ?? []).filter((m) => live(m, now));
    const rest = new Set(terms([t.definition ?? "", ...t.examples, ...seen.map((m) => m.statement)].join(" ")));
    return { t, name, all: new Set([...name, ...rest]) };
  });
  const df = new Map<string, number>();
  for (const b of bags) for (const w of b.all) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log(1 + bags.length / (df.get(w) ?? 1));
  return bags
    .map((b) => {
      let score = 0;
      for (const w of asked) if (b.all.has(w)) score += idf(w) * (b.name.has(w) ? 2 : 1);
      return { t: b.t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, n)
    .map((x) => x.t);
}

/**
 * Wakes the part of the tree a question touches (world-tree §6.4; answering spec §2, steps 2–3). From each seed: its
 * ancestors, its children and its related links. The seed's own memories all count; a nearby node's count only when
 * they share a word with the question. The bundle already holds only what a visitor may be told, so what is left to
 * filter is expiry and the budget.
 */
export function awaken(v: BundleView, question: string, seedIds: string[], opts: { budget: number; now: string }): Awakened {
  const asked = new Set(terms(question));
  const seeds: Seed[] = [];
  const hypotheses: Awakened["hypotheses"] = [];
  const reached = new Map<string, boolean>(); // node → is a seed
  for (const id of seedIds) {
    const n = v.nodes.get(id);
    if (!n) continue;
    seeds.push({ id, name: n.name, root: n.root, knowledge: n.answer !== null, mode: n.answer?.mode ?? null });
    if (n.answer?.via === "guess" && n.answer.mode !== "decline" && n.answer.depth !== null) hypotheses.push({ nodeId: id, name: n.name, depth: n.answer.depth });
    reached.set(id, true);
    for (const near of [...pathUp(v, id).slice(1), ...(v.children.get(id) ?? []), ...(v.related.get(id) ?? [])]) if (!reached.has(near)) reached.set(near, false);
  }

  const filtered: Awakened["filtered"] = [];
  const kept: { m: ContextMemory; score: number; order: number }[] = [];
  const done = new Set<string>();
  for (const [nodeId, isSeed] of reached) {
    const nodeName = v.nodes.get(nodeId)!.name;
    for (const m of v.memoriesOf.get(nodeId) ?? []) {
      if (done.has(m.id)) continue;
      done.add(m.id);
      const shared = terms(m.statement).filter((w) => asked.has(w)).length;
      if (!isSeed && shared === 0) continue;
      if (!live(m, opts.now)) {
        filtered.push({ id: m.id, reason: "expired" });
        continue;
      }
      kept.push({ m: { id: m.id, statement: m.statement, kind: m.kind, tier: m.tier, nodeId, nodeName }, score: shared, order: kept.length });
    }
  }
  kept.sort((a, b) => b.score - a.score || a.order - b.order);
  for (const k of kept.slice(opts.budget)) filtered.push({ id: k.m.id, reason: "budget" });
  return { seeds, memories: kept.slice(0, opts.budget).map((k) => k.m), hypotheses, filtered };
}

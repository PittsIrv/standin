import { answerMode, loadSnapshot, type AnswerMode, type TreeSnapshot } from "@standin/knowledge";
import type { Memory, MemoryKind, RootKey, Tier, Topic } from "@standin/schema";
import type { Store } from "@standin/store";

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
  mode: AnswerMode | null;
  /** The node or an ancestor is a tier-3 boundary: the standin deflects. */
  boundary: boolean;
}

export type FilterReason = "status" | "tier" | "boundary" | "expired" | "budget";

export interface Awakened {
  seeds: Seed[];
  memories: ContextMemory[];
  /** Guesses at or above `speakAt` about a seed with nothing on record: spoken only hedged. */
  hypotheses: { nodeId: string; name: string; depth: number; p: number }[];
  filtered: { id: string; reason: FilterReason }[];
  /** Statements kept from the speaker for any reason but the budget: a reply quoting one is a leak. */
  hidden: string[];
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

/** What a visitor may be told: approved, tier 1–2, not expired (the branch is checked separately). */
export const allowed = (m: Memory, now: string) => m.status === "approved" && m.tier <= 2 && (m.validUntil === null || m.validUntil > now);

/** The node and its home ancestors, nearest first. */
function pathUp(store: Store, id: string): string[] {
  const path: string[] = [];
  for (let at: string | null = id; at && !path.includes(at); at = store.homeParent(at)) path.push(at);
  return path;
}

/** The node or an ancestor is a tier-3 boundary. */
export const underBoundary = (store: Store, id: string) => pathUp(store, id).some((n) => store.getTopic(n).boundaryTier === 3);

/** Memories homed on a node or linked to it, without repeats. */
function memoriesOf(store: Store, id: string): Memory[] {
  const seen = new Map<string, Memory>();
  for (const m of [...store.nodeMemories(id), ...store.topicMemories(id)]) seen.set(m.id, m);
  return [...seen.values()];
}

/**
 * The nodes a question may be about (answering spec §2, step 1): ranked by the words they share with it, rarer words
 * counting more. A word of the node's name or aliases counts double; its definition, examples and the memories a
 * visitor may see count once. Words of hidden memories are never used, so routing can't reveal them.
 */
export function candidates(store: Store, question: string, n = LIMITS.candidates): Topic[] {
  const now = store.nowIso();
  const asked = new Set(terms(question));
  if (asked.size === 0) return [];
  const bags = store.listTopics({ includeRoots: true }).map((t) => {
    const name = new Set(terms([t.name, ...t.aliases].join(" ")));
    const seen = memoriesOf(store, t.id).filter((m) => allowed(m, now));
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
 * they share a word with the question. Filtering happens here, before any text reaches a model: only approved
 * memories at tier 1–2, unexpired, outside any tier-3 branch, best-matching first, up to the budget.
 */
export function awaken(store: Store, question: string, seedIds: string[], opts: { budget: number; speakAt: number; snapshot?: TreeSnapshot }): Awakened {
  const t = opts.snapshot ?? loadSnapshot(store);
  const now = store.nowIso();
  const asked = new Set(terms(question));
  const related = store.listEdges("related");
  const seeds: Seed[] = [];
  const hypotheses: Awakened["hypotheses"] = [];
  const reached = new Map<string, boolean>(); // node → is a seed
  for (const id of seedIds) {
    const topic = store.getTopic(id);
    const knowledge = t.knowledge.has(id);
    const decision = knowledge ? answerMode(t, id, { speakAt: opts.speakAt }) : null;
    const boundary = underBoundary(store, id);
    seeds.push({ id, name: topic.name, root: topic.rootKey ?? store.rootOf(id), knowledge, mode: decision?.mode ?? null, boundary });
    if (decision?.from?.via === "hypothesis" && decision.mode !== "decline") {
      const h = t.hypotheses.get(id)!;
      hypotheses.push({ nodeId: id, name: topic.name, depth: h.depth, p: h.p });
    }
    reached.set(id, true);
    const near = [
      ...pathUp(store, id).slice(1),
      ...[...t.parentOf].filter(([, parent]) => parent === id).map(([child]) => child),
      ...related.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])),
    ];
    for (const n of near) if (!reached.has(n)) reached.set(n, false);
  }

  const filtered: Awakened["filtered"] = [];
  const hidden: string[] = [];
  const kept: { m: ContextMemory; score: number; order: number }[] = [];
  const done = new Set<string>();
  for (const [nodeId, isSeed] of reached) {
    const blocked = underBoundary(store, nodeId);
    const nodeName = store.getTopic(nodeId).name;
    for (const m of memoriesOf(store, nodeId)) {
      if (done.has(m.id)) continue;
      done.add(m.id);
      const shared = terms(m.statement).filter((w) => asked.has(w)).length;
      if (!isSeed && shared === 0) continue;
      const reason: FilterReason | null =
        m.status !== "approved" ? "status" : m.tier > 2 ? "tier" : blocked ? "boundary" : m.validUntil !== null && m.validUntil <= now ? "expired" : null;
      if (reason) {
        filtered.push({ id: m.id, reason });
        hidden.push(m.statement);
        continue;
      }
      kept.push({ m: { id: m.id, statement: m.statement, kind: m.kind, tier: m.tier, nodeId, nodeName }, score: shared, order: kept.length });
    }
  }
  kept.sort((a, b) => b.score - a.score || a.order - b.order);
  for (const k of kept.slice(opts.budget)) filtered.push({ id: k.m.id, reason: "budget" });
  return { seeds, memories: kept.slice(0, opts.budget).map((k) => k.m), hypotheses, filtered, hidden };
}

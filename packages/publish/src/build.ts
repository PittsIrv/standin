import { answerMode, loadSnapshot, type TreeSnapshot } from "@standin/knowledge";
import type { Bundle, BundleAnswer, BundleMemory, BundleNode, Memory } from "@standin/schema";
import type { Store } from "@standin/store";

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

const VIA: Record<string, BundleAnswer["via"]> = { own: "own", gap: "own", inherited: "inherited", hypothesis: "guess" };

export interface BuildOptions {
  personaName: string;
  speakAt: number;
  /** A snapshot to use instead of loading one (tests). */
  snapshot?: TreeSnapshot;
}

/**
 * The draft bundle (publish spec §2): everything a visitor's turn may use, and nothing else. Memories are approved,
 * tier 1–2, unexpired and off every boundary; a node is included if it carries one of them, a level of its own or a
 * confident guess it can speak to, and so is its path to the root. Nothing on or under a boundary is included, not even its name.
 * Answering modes are worked out here, so probes, gaps and guess reasons never leave the store. Pure: no model calls,
 * no files.
 */
export function buildBundle(store: Store, opts: BuildOptions): Bundle {
  const now = store.nowIso();
  const t = opts.snapshot ?? loadSnapshot(store);
  const topics = new Map(store.listTopics({ includeRoots: true }).map((x) => [x.id, x]));
  const blockedCache = new Map<string, boolean>();
  const blocked = (id: string) => {
    let b = blockedCache.get(id);
    if (b === undefined) blockedCache.set(id, (b = underBoundary(store, id)));
    return b;
  };

  const memories: BundleMemory[] = [];
  const carries = new Set<string>();
  for (const m of store.listMemories({ status: "approved" })) {
    if (!allowed(m, now)) continue;
    const linked = store.memoryEntities(m.id).map((e) => e.id);
    const nodes = [...new Set([...(m.homeNodeId ? [m.homeNodeId] : []), ...linked])].filter((id) => topics.has(id));
    if (nodes.length === 0 || nodes.some(blocked)) continue;
    memories.push({ id: m.id, statement: m.statement, kind: m.kind, tier: m.tier as 1 | 2, nodes, validUntil: m.validUntil });
    for (const id of nodes) carries.add(id);
  }

  const answers = new Map<string, ReturnType<typeof answerMode>>();
  for (const id of t.knowledge) {
    if (blocked(id)) continue;
    const a = answerMode(t, id, { speakAt: opts.speakAt });
    answers.set(id, a);
    // Something to say of its own. A concept known only as not known adds nothing a visitor can tell apart.
    if (a.from?.nodeId === id && a.mode !== "decline") carries.add(id);
  }

  const included = new Set<string>();
  for (const id of carries) for (const n of pathUp(store, id)) if (!blocked(n)) included.add(n);

  const nodes: BundleNode[] = [...included].map((id) => {
    const x = topics.get(id)!;
    const parent = store.homeParent(id);
    let answer: BundleAnswer | null = null;
    if (t.knowledge.has(id)) {
      const a = answers.get(id) ?? answerMode(t, id, { speakAt: opts.speakAt });
      answer = { mode: a.mode, depth: a.depth, via: a.from ? VIA[a.from.via]! : null };
    }
    return {
      id,
      name: x.name,
      aliases: x.aliases,
      definition: x.definition ?? null,
      examples: x.examples,
      root: x.rootKey ?? store.rootOf(id),
      parent: parent && included.has(parent) ? parent : null,
      answer,
    };
  });
  nodes.sort((a, b) => (a.root ?? "~").localeCompare(b.root ?? "~") || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const related = store
    .listEdges("related")
    .filter((e) => included.has(e.from) && included.has(e.to))
    .map((e) => [e.from, e.to] as [string, string]);

  return {
    format: 1,
    version: 0,
    createdAt: now,
    persona: { name: opts.personaName },
    nodes,
    related,
    memories: memories.sort((a, b) => a.id.localeCompare(b.id)),
    exemplars: store.listExemplars({ status: "approved" }).map((e) => ({ id: e.id, text: e.text, register: e.register })),
  };
}

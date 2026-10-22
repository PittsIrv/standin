import type { LLM } from "@standin/llm";
import { BACKGROUND_EVIDENCE, type EntityKind, type RawScore, type Topic } from "@standin/schema";
import { CycleError, normalizeName, type Store } from "@standin/store";
import { buildPlacePrompt, buildSeedPrompt, outline } from "./prompts.ts";
import { spokenFor } from "./hypotheses/guards.ts";
import { isSensitive } from "./hypotheses/sensitive.ts";
import { loadSnapshot } from "./snapshot.ts";
import { PlaceSchema, SeedSchema } from "./schemas.ts";

/**
 * Nodes from the person's data with no place in the tree yet: no home parent and no parts, linked to (or home of) an
 * approved memory. A node with parts (a seeded field, a parent created by placement) is already placed.
 */
export function unplacedNodes(store: Store): Topic[] {
  const edges = store.listEdges("part_of");
  const placed = new Set([...edges.map((e) => e.from), ...edges.map((e) => e.to)]);
  return store
    .listTopics()
    .filter((t) => !placed.has(t.id) && (store.topicMemories(t.id, { status: "approved" }).length > 0 || store.nodeMemories(t.id, { status: "approved" }).length > 0));
}

/** A live node (roots included) by name or alias, preferring one with the given label. */
export function findNode(store: Store, name: string, label?: EntityKind): Topic | null {
  const key = normalizeName(name);
  const matches = [...store.roots(), ...store.listTopics()].filter((t) => [t.name, ...t.aliases].some((n) => normalizeName(n) === key));
  return matches.find((t) => t.label === label) ?? matches[0] ?? null;
}

/** One `map` call: merges duplicates into existing nodes and places the rest under any root. Only requested nodes are touched. */
export async function placeNodes(store: Store, model: LLM, personaName: string): Promise<{ placed: number; merged: number; refused: string[] }> {
  const pending = unplacedNodes(store);
  if (pending.length === 0) return { placed: 0, merged: 0, refused: [] };
  const parentOf = new Map(store.listEdges("part_of").map((e) => [e.from, e.to]));
  const result = await model.generateObject({
    ...buildPlacePrompt(pending.map((t) => `${t.name} [${t.label}]`), outline([...store.roots(), ...store.listTopics()], parentOf), personaName),
    schema: PlaceSchema,
    purpose: "place",
  });
  const requested = new Map(pending.map((t) => [normalizeName(t.name), t]));
  const report = { placed: 0, merged: 0, refused: [] as string[] };
  store.transaction(() => {
    for (const m of result.merges) {
      const from = requested.get(normalizeName(m.from));
      const into = from ? findNode(store, m.into, from.label) : null;
      if (!from || !into || into.id === from.id || into.rootKey) continue;
      store.mergeTopics(from.id, into.id);
      requested.delete(normalizeName(m.from));
      report.merged++;
    }
    for (const p of result.placements) {
      const node = requested.get(normalizeName(p.topic));
      if (!node) continue;
      let parent = findNode(store, p.parent);
      if (!parent) {
        parent = store.ensureNode(p.parent, p.parentLabel, p.parentDefinition);
        store.addEdge({ from: parent.id, to: store.root(p.root).id, kind: "part_of", source: "placement" });
      }
      if (parent.deletedAt) continue;
      if (p.definition.trim() && !node.definition) store.setTopic(node.id, { definition: p.definition.trim() });
      try {
        if (store.addEdge({ from: node.id, to: parent.id, kind: "part_of", source: "placement" })) report.placed++;
      } catch (err) {
        if (!(err instanceof CycleError)) throw err;
        report.refused.push(node.name);
      }
    }
  });
  return report;
}

const SEEDED = (memoryId: string) => `seeded:${memoryId}`;
const STRENGTH = new Map<string, number>(BACKGROUND_EVIDENCE.map((k, i) => [k, i]));
const RAW: Record<number, RawScore> = { 1: "low", 2: "medium" };

/**
 * One `map` call over every approved background fact not yet seeded (intro-sources spec §5): the concepts they imply,
 * each a guess at the depth the model picked, with its reason and the facts it rests on. The guess's evidence kind is
 * its strongest evidence; its raw score grows with how many facts back it. Nothing the person already spoke to, nothing
 * sensitive, and nothing that would loop is guessed.
 */
export async function seedBackground(store: Store, model: LLM, personaName: string): Promise<{ seeded: string[] }> {
  const seededFrom = new Set(store.listTopics({ includeDeleted: true }).map((t) => t.seedMemoryId).filter(Boolean));
  const facts = store
    .listMemories({ status: "approved", kind: "fact" })
    .filter((m) => m.kind === "fact" && m.attrs.background === true && !seededFrom.has(m.id) && store.getKv(SEEDED(m.id)) === null);
  if (facts.length === 0) return { seeded: [] };
  const answer = await model.generateObject({
    ...buildSeedPrompt(facts.map((f) => ({ statement: f.statement, ...(f.kind === "fact" ? f.attrs : {}) })), personaName),
    schema: SeedSchema,
    purpose: "seed",
  });
  const seeded: string[] = [];
  store.transaction(() => {
    for (const f of facts) store.setKv(SEEDED(f.id), store.nowIso());
    type Concept = (typeof answer.concepts)[number] & { support: { factId: string; type: (typeof BACKGROUND_EVIDENCE)[number] }[] };
    const concepts: Concept[] = [];
    for (const c of answer.concepts) {
      const support = c.evidence
        .filter((e) => Number.isInteger(e.fact) && e.fact >= 1 && e.fact <= facts.length)
        .map((e) => ({ factId: facts[e.fact - 1]!.id, type: (STRENGTH.has(e.type) ? e.type : "self") as (typeof BACKGROUND_EVIDENCE)[number] }));
      if (support.length > 0 && !isSensitive(c.name)) concepts.push({ ...c, support });
    }
    const placed = new Map<string, string>();
    const place = (c: Concept, parentId: string): string | null => {
      const node = store.ensureTopic(c.name, c.definition);
      if (node.deletedAt || node.id === parentId) return null;
      try {
        store.addEdge({ from: node.id, to: parentId, kind: "part_of", source: "seeding" });
      } catch (err) {
        if (err instanceof CycleError) return null;
        throw err;
      }
      const strongest = [...c.support].sort((a, b) => STRENGTH.get(a.type)! - STRENGTH.get(b.type)!)[0]!;
      if (!node.seedMemoryId) store.setTopic(node.id, { seedMemoryId: strongest.factId });
      if (node.examples.length === 0 && c.examples.length > 0) store.setTopic(node.id, { examples: c.examples.map((e) => e.trim()).filter(Boolean).slice(0, 5) });
      return node.id;
    };
    // Parents before their parts; a part whose parent isn't in the answer (or is refused) goes under the Knowledge root.
    let pending = concepts;
    while (pending.length > 0) {
      const waiting = new Set(pending.map((c) => normalizeName(c.name)));
      const ready = pending.filter((c) => !c.partOf || !waiting.has(normalizeName(c.partOf)));
      // Parts naming each other in a circle all go to the root.
      const batch = ready.length > 0 ? ready : pending;
      for (const c of batch) {
        const parentId = (c.partOf && placed.get(normalizeName(c.partOf))) || store.root("knowledge").id;
        const id = place(c, parentId);
        if (id) placed.set(normalizeName(c.name), id);
        if (id && !c.partOf) seeded.push(c.name);
      }
      pending = pending.filter((c) => !batch.includes(c));
    }
    // Guesses, until a card says so; never about something the person already spoke to.
    const t = loadSnapshot(store);
    for (const c of concepts) {
      const nodeId = placed.get(normalizeName(c.name));
      if (!nodeId || spokenFor(t, nodeId) || store.listHypotheses({ nodeId }).some((h) => h.status !== "withdrawn")) continue;
      const strongest = [...c.support].sort((a, b) => STRENGTH.get(a.type)! - STRENGTH.get(b.type)!)[0]!;
      const backing = new Set(c.support.map((s) => s.factId)).size;
      const parentId = c.partOf ? placed.get(normalizeName(c.partOf)) : undefined;
      store.insertHypothesis({
        nodeId,
        depth: Math.min(4, Math.max(1, Math.round(c.depth))),
        rawScore: RAW[backing] ?? "high",
        kind: strongest.type,
        path: parentId ? [parentId, nodeId] : [nodeId],
        reason: c.reason.trim() || "from your background",
      });
    }
  });
  return { seeded };
}

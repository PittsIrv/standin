import type { LLM } from "@standin/llm";
import type { EntityKind, Topic } from "@standin/schema";
import { CycleError, normalizeName, type Store } from "@standin/store";
import { buildPlacePrompt, buildSeedPrompt, outline } from "./prompts.ts";
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
function findNode(store: Store, name: string, label?: EntityKind): Topic | null {
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

/** One `map` call per approved background fact not yet seeded: the field plus its core topics. */
export async function seedBackground(store: Store, model: LLM, personaName: string): Promise<{ seeded: string[] }> {
  const seededFrom = new Set(store.listTopics({ includeDeleted: true }).map((t) => t.seedMemoryId).filter(Boolean));
  const facts = store
    .listMemories({ status: "approved", kind: "fact" })
    .filter((m) => m.kind === "fact" && m.attrs.background === true && !seededFrom.has(m.id));
  const seeded: string[] = [];
  for (const fact of facts) {
    const seed = await model.generateObject({ ...buildSeedPrompt(fact.statement, personaName), schema: SeedSchema, purpose: "seed" });
    store.transaction(() => {
      // The field itself is seeded too: background means working knowledge of the field as a whole.
      const field = store.ensureTopic(seed.field.name, seed.field.definition);
      if (!field.seedMemoryId && !field.deletedAt) store.setTopic(field.id, { seedMemoryId: fact.id });
      store.addEdge({ from: field.id, to: store.root("knowledge").id, kind: "part_of", source: "seeding" });
      for (const c of seed.core) {
        const core = store.ensureTopic(c.name, c.definition);
        if (core.deletedAt || core.id === field.id) continue;
        if (!core.seedMemoryId) store.setTopic(core.id, { seedMemoryId: fact.id });
        store.addEdge({ from: core.id, to: field.id, kind: "part_of", source: "seeding" });
      }
    });
    seeded.push(seed.field.name);
  }
  return { seeded };
}

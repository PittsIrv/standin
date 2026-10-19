import type { LLM } from "@standin/llm";
import { CycleError, type Store } from "@standin/store";
import { buildPlacePrompt, buildSeedPrompt, outline } from "./prompts.ts";
import { PlaceSchema, SeedSchema } from "./schemas.ts";

/**
 * Topics from the person's data that have no place in the tree yet: no parent and no parts, linked to an approved
 * memory. A root with parts (a seeded field, a parent created by placement) is already placed.
 */
export function unplacedTopics(store: Store) {
  const edges = store.listEdges("part_of");
  const placed = new Set([...edges.map((e) => e.from), ...edges.map((e) => e.to)]);
  return store.listTopics().filter((t) => !placed.has(t.id) && store.topicMemories(t.id, { status: "approved" }).length > 0);
}

/** One `map` call: merges duplicates into existing nodes and places the rest. Only requested topics are touched. */
export async function placeTopics(store: Store, model: LLM, personaName: string): Promise<{ placed: number; merged: number; refused: string[] }> {
  const pending = unplacedTopics(store);
  if (pending.length === 0) return { placed: 0, merged: 0, refused: [] };
  const parentOf = new Map(store.listEdges("part_of").map((e) => [e.from, e.to]));
  const result = await model.generateObject({
    ...buildPlacePrompt(pending.map((t) => t.name), outline(store.listTopics(), parentOf), personaName),
    schema: PlaceSchema,
    purpose: "place",
  });
  const requested = new Map(pending.map((t) => [t.name.toLowerCase(), t]));
  const report = { placed: 0, merged: 0, refused: [] as string[] };
  store.transaction(() => {
    for (const m of result.merges) {
      const from = requested.get(m.from.toLowerCase());
      const into = store.findEntity({ name: m.into, kind: "topic" });
      if (!from || !into || into.id === from.id) continue;
      store.mergeTopics(from.id, into.id);
      requested.delete(m.from.toLowerCase());
      report.merged++;
    }
    for (const p of result.placements) {
      const topic = requested.get(p.topic.toLowerCase());
      if (!topic) continue;
      const parent = store.ensureTopic(p.parent, p.parentDefinition);
      if (p.definition.trim()) store.setTopic(topic.id, { definition: p.definition.trim() });
      try {
        if (store.addEdge({ from: topic.id, to: parent.id, kind: "part_of", source: "placement" })) report.placed++;
      } catch (err) {
        if (!(err instanceof CycleError)) throw err;
        report.refused.push(topic.name);
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

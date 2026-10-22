import type { LLM } from "@standin/llm";
import type { Topic } from "@standin/schema";
import { CycleError, normalizeName, type Store } from "@standin/store";
import { buildExpandPrompt } from "./prompts.ts";
import { ExpandSchema } from "./schemas.ts";

export const MIN_SPLIT = 3;
export const MAX_SPLIT = 7;

type Component = { name: string; definition: string; level: number };

/**
 * A split's shape, checked in code (concept-cards spec §6): 3–7 parts, each named once, none the concept itself (or
 * one of its names), each with a level 1–4. Returns the valid parts and what was wrong.
 */
export function checkSplit(parent: Topic, components: Component[]): { ok: Component[]; problems: string[] } {
  const problems: string[] = [];
  const own = new Set([parent.name, ...parent.aliases].map(normalizeName));
  const seen = new Set<string>();
  const ok: Component[] = [];
  for (const c of components) {
    const key = normalizeName(c.name);
    if (!key) continue;
    if (own.has(key)) problems.push(`"${c.name}" is the concept itself`);
    else if (seen.has(key)) problems.push(`"${c.name}" is a duplicate`);
    else if (!Number.isInteger(c.level) || c.level < 1 || c.level > 4) problems.push(`"${c.name}" needs a level from 1 to 4`);
    else ok.push(c);
    seen.add(key);
  }
  if (ok.length < MIN_SPLIT || ok.length > MAX_SPLIT) problems.push(`a split needs ${MIN_SPLIT}–${MAX_SPLIT} parts (got ${ok.length} usable)`);
  return { ok, problems };
}

/**
 * One `map` call per node, ever (two if the first split is malformed): its parts (part_of) with their levels, and its
 * prerequisites (requires). New parts wait on the frontier. Edges that would loop are skipped.
 */
export async function expandNode(store: Store, map: LLM, nodeId: string, personaName: string): Promise<{ components: string[]; prerequisites: string[] }> {
  const node = store.getTopic(nodeId);
  if (node.expandedAt) return { components: [], prerequisites: [] };
  const parentId = store.homeParent(nodeId);
  const parent = parentId ? store.getTopic(parentId).name : null;
  const ask = (problems: string[]) => map.generateObject({ ...buildExpandPrompt(node, parent, personaName, problems), schema: ExpandSchema, purpose: "expand" });
  let out = await ask([]);
  let checked = checkSplit(node, out.components);
  if (checked.problems.length > 0) {
    out = await ask(checked.problems);
    checked = checkSplit(node, out.components);
  }
  const added = { components: [] as string[], prerequisites: [] as string[] };
  store.transaction(() => {
    const link = (name: string, definition: string, kind: "part_of" | "requires", level?: number) => {
      const isNew = store.findEntity({ name, kind: "topic" }) === null;
      const other = store.ensureTopic(name, definition);
      if (other.deletedAt || other.id === nodeId) return false;
      try {
        const edge = kind === "part_of" ? { from: other.id, to: nodeId } : { from: nodeId, to: other.id };
        if (!store.addEdge({ ...edge, kind, source: "expansion" })) return false;
      } catch (err) {
        if (err instanceof CycleError) return false;
        throw err;
      }
      // Parts nobody has talked about yet wait on the frontier, hidden until a claim, card or edit touches them.
      if (kind === "part_of") store.setTopic(other.id, { ...(isNew ? { frontier: true } : {}), ...(other.partLevel === null && level ? { partLevel: level } : {}) });
      return true;
    };
    for (const c of checked.ok) if (link(c.name, c.definition, "part_of", c.level)) added.components.push(c.name);
    for (const p of out.prerequisites) if (link(p.name, p.definition, "requires")) added.prerequisites.push(p.name);
    store.setTopic(nodeId, { expandedAt: store.nowIso() });
  });
  return added;
}

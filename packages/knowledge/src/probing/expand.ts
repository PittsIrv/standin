import type { LLM } from "@standin/llm";
import { CycleError, type Store } from "@standin/store";
import { buildExpandPrompt } from "./prompts.ts";
import { ExpandSchema } from "./schemas.ts";

/** One `map` call per node, ever: its parts (part_of) and prerequisites (requires). Edges that would loop are skipped. */
export async function expandNode(store: Store, map: LLM, nodeId: string, personaName: string): Promise<{ components: string[]; prerequisites: string[] }> {
  const node = store.getTopic(nodeId);
  if (node.expandedAt) return { components: [], prerequisites: [] };
  const parentEdge = store.listEdges("part_of").find((e) => e.from === nodeId);
  const parent = parentEdge ? store.getTopic(parentEdge.to).name : null;
  const out = await map.generateObject({ ...buildExpandPrompt(node, parent, personaName), schema: ExpandSchema, purpose: "expand" });
  const added = { components: [] as string[], prerequisites: [] as string[] };
  store.transaction(() => {
    const link = (name: string, definition: string, kind: "part_of" | "requires") => {
      const isNew = store.findEntity({ name, kind: "topic" }) === null;
      const other = store.ensureTopic(name, definition);
      // Parts nobody has talked about yet wait on the frontier, hidden until a claim, probe or edit touches them.
      if (isNew && kind === "part_of") store.setTopic(other.id, { frontier: true });
      if (other.deletedAt || other.id === nodeId) return false;
      try {
        const edge = kind === "part_of" ? { from: other.id, to: nodeId } : { from: nodeId, to: other.id };
        return store.addEdge({ ...edge, kind, source: "expansion" }) !== null;
      } catch (err) {
        if (err instanceof CycleError) return false;
        throw err;
      }
    };
    for (const c of out.components) if (link(c.name, c.definition, "part_of")) added.components.push(c.name);
    for (const p of out.prerequisites) if (link(p.name, p.definition, "requires")) added.prerequisites.push(p.name);
    store.setTopic(nodeId, { expandedAt: store.nowIso() });
  });
  return added;
}

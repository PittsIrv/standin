import type { LLM } from "@standin/llm";
import { normalizeName, type Store } from "@standin/store";
import { buildHomePrompt, buildSplitPrompt, outline } from "./prompts.ts";
import { HomeSchema, SplitSchema } from "./schemas.ts";
import { findNode } from "./tasks.ts";

/** The whole tree, roots first, for a prompt. */
function tree(store: Store): string {
  const parentOf = new Map(store.listEdges("part_of").map((e) => [e.from, e.to]));
  return outline([...store.roots(), ...store.listTopics()], parentOf);
}

/**
 * One `map` call: every approved memory without a home gets one, in an existing node or a new one under the parent the
 * model names. `grew` lists nodes that gained a child here: a sign their own memories may belong to it.
 */
export async function homeMemories(store: Store, model: LLM, personaName: string): Promise<{ homed: number; created: string[]; grew: string[] }> {
  const homeless = store.listMemories({ status: "approved" }).filter((m) => m.homeNodeId === null);
  if (homeless.length === 0) return { homed: 0, created: [], grew: [] };
  const out = await model.generateObject({ ...buildHomePrompt(homeless, tree(store), personaName), schema: HomeSchema, purpose: "home" });
  const wanted = new Set(homeless.map((m) => m.id));
  const report = { homed: 0, created: [] as string[], grew: [] as string[] };
  store.transaction(() => {
    for (const h of out.homes) {
      if (!wanted.has(h.memoryId)) continue;
      let node = findNode(store, h.node, h.newNode?.label);
      if (!node && h.newNode) {
        const parent = findNode(store, h.newNode.parent);
        if (!parent || parent.deletedAt) continue;
        node = store.ensureNode(h.node, h.newNode.label, h.newNode.definition);
        if (node.deletedAt) continue;
        if (store.addEdge({ from: node.id, to: parent.id, kind: "part_of", source: "placement" })) {
          report.created.push(node.name);
          if (!parent.rootKey) report.grew.push(parent.id);
        }
      }
      if (!node || node.deletedAt) continue;
      store.setHome(h.memoryId, node.id);
      wanted.delete(h.memoryId);
      report.homed++;
    }
  });
  return report;
}

/**
 * Splits nodes whose parts have their own identity: one `map` call per node holding more than `splitAt` approved
 * memories, or per node in `grew` that still holds some. Only listed memories this node holds move to a child.
 */
export async function splitNodes(
  store: Store,
  model: LLM,
  personaName: string,
  splitAt: number,
  grew: ReadonlySet<string> = new Set(),
): Promise<{ split: string[] }> {
  const split: string[] = [];
  for (const node of store.listTopics()) {
    const held = store.nodeMemories(node.id, { status: "approved" });
    if (held.length === 0 || (held.length <= splitAt && !grew.has(node.id))) continue;
    const children = store
      .listEdges("part_of")
      .filter((e) => e.to === node.id)
      .map((e) => store.getTopic(e.from));
    const out = await model.generateObject({
      ...buildSplitPrompt(node.name, children.map((c) => c.name), held, personaName),
      schema: SplitSchema,
      purpose: "split",
    });
    const mine = new Set(held.map((m) => m.id));
    let changed = false;
    store.transaction(() => {
      for (const c of out.children) {
        if (normalizeName(c.name) === normalizeName(node.name)) continue;
        let child = children.find((x) => [x.name, ...x.aliases].some((n) => normalizeName(n) === normalizeName(c.name)));
        if (!child) {
          const made = store.ensureNode(c.name, c.label, c.definition);
          if (made.deletedAt || !store.addEdge({ from: made.id, to: node.id, kind: "part_of", source: "placement" })) continue;
          child = made;
          changed = true;
        }
        for (const id of c.memoryIds) {
          if (!mine.has(id)) continue;
          store.setHome(id, child.id);
          mine.delete(id);
          changed = true;
        }
      }
    });
    if (changed) split.push(node.name);
  }
  return { split };
}

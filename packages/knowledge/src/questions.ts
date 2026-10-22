import type { LLM } from "@standin/llm";
import type { Topic } from "@standin/schema";
import type { Store } from "@standin/store";
import { isSensitive } from "./hypotheses/sensitive.ts";
import { buildQuestionPrompt } from "./prompts.ts";
import { QuestionSchema } from "./schemas.ts";

/** Starting values (questions spec §5). */
export const QUESTION_LIMITS = { perRefresh: 3, open: 10 };

/**
 * Asks about gaps in the five trees beyond Knowledge (questions spec §1): one `map` call over the nodes (roots
 * included) that hold approved facts and have no open or dismissed question, for at most one question each. Questions
 * are never facts, and never touch a sensitive category.
 */
export async function askQuestions(store: Store, model: LLM, personaName: string, limits = QUESTION_LIMITS): Promise<{ asked: number }> {
  const open = store.listQuestions({ status: "open" }).length;
  const room = Math.min(limits.perRefresh, limits.open - open);
  if (room <= 0) return { asked: 0 };
  const touched = new Set(store.listQuestions({}).filter((q) => q.status !== "answered").map((q) => q.nodeId));
  const nodes = store
    .listTopics({ includeRoots: true })
    .filter((t) => !touched.has(t.id) && t.boundaryTier === null)
    .map((t) => ({ topic: t, root: t.rootKey ?? store.rootOf(t.id), facts: store.nodeMemories(t.id, { status: "approved" }).map((m) => m.statement) }))
    .filter((n): n is { topic: Topic; root: NonNullable<typeof n.root>; facts: string[] } => n.root !== null && n.root !== "knowledge" && n.facts.length > 0);
  if (nodes.length === 0) return { asked: 0 };
  const out = await model.generateObject({ ...buildQuestionPrompt(nodes, personaName), schema: QuestionSchema, purpose: "question" });
  let asked = 0;
  const done = new Set<string>();
  store.transaction(() => {
    for (const q of out.questions) {
      const node = nodes[q.node - 1];
      const text = q.question.trim().replace(/\s+/g, " ");
      if (asked >= room || !node || done.has(node.topic.id) || !text || text.length > 200 || isSensitive(text)) continue;
      store.addQuestion({ nodeId: node.topic.id, text });
      done.add(node.topic.id);
      asked++;
    }
  });
  return { asked };
}

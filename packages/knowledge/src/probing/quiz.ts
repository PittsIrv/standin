import type { LLM } from "@standin/llm";
import type { Holdout, Probe, ProbeKind } from "@standin/schema";
import type { Store } from "@standin/store";
import { buildQuizPrompt } from "./prompts.ts";
import { QuizSchema } from "./schemas.ts";

export const FIXED_SHARE = 0.1;
export const ROTATING_SHARE = 0.2;

/** Held-out sets, assigned once when a probe is written: about 10% fixed, 20% rotating. */
export function assignHoldout(rng: () => number): Holdout {
  const x = rng();
  return x < FIXED_SHARE ? "fixed" : x < FIXED_SHARE + ROTATING_SHARE ? "rotating" : "none";
}

/** One `quiz` call: `count` probes for a node at a difficulty, each assigned a holdout set. */
export async function writeProbes(
  store: Store,
  quiz: LLM,
  o: { nodeId: string; difficulty: number; kind: ProbeKind; checkOf: string | null; count: number; rng: () => number; personaName?: string },
): Promise<Probe[]> {
  const node = store.getTopic(o.nodeId);
  const parentEdge = store.listEdges("part_of").find((e) => e.from === o.nodeId);
  const parent = parentEdge ? store.getTopic(parentEdge.to).name : null;
  const out = await quiz.generateObject({
    ...buildQuizPrompt(node, parent, o.difficulty, o.count, o.personaName ?? "the person"),
    schema: QuizSchema,
    purpose: "quiz",
  });
  return out.probes
    .map((p) => p.question.trim())
    .filter((q) => q.length > 0)
    .slice(0, o.count)
    .map((question) =>
      store.insertProbe({ nodeId: o.nodeId, checkOf: o.checkOf, kind: o.kind, difficulty: o.difficulty, question, holdout: assignHoldout(o.rng) }),
    );
}

import { supportsBatch, type LLM } from "@standin/llm";
import type { Store } from "@standin/store";
import { buildGradePrompt } from "./prompts.ts";
import { GradeSchema } from "./schemas.ts";

/** Whether to grade through a batch: a traced model knows whether its provider has one. */
const batchable = (grade: LLM) =>
  "batchCapable" in grade ? Boolean((grade as { batchCapable: boolean }).batchCapable) : supportsBatch(grade);

/** Collects finished grading batches. A failed result is cleared so the answer is resubmitted next time. */
export async function collectGrades(store: Store, grade: LLM): Promise<{ collected: number; failedResubmit: number }> {
  const out = { collected: 0, failedResubmit: 0 };
  if (!supportsBatch(grade)) return out;
  const pending = store.listResponses({ ungraded: true }).filter((r) => r.gradeBatchId !== null);
  for (const batchId of new Set(pending.map((r) => r.gradeBatchId!))) {
    const status = await grade.batchStatus(batchId);
    if (!status.ended) continue;
    const results = await grade.batchResults(batchId, GradeSchema);
    for (const r of pending.filter((x) => x.gradeBatchId === batchId)) {
      const outcome = results.get(r.id);
      if (outcome?.ok) {
        store.recordGrade(r.id, outcome.value.grade, outcome.value.reason);
        out.collected++;
      } else {
        store.setGradeBatch([r.id], null);
        out.failedResubmit++;
      }
    }
  }
  return out;
}

/** Grades answered spot-checks not yet graded or in a batch: one batch when the provider has one, otherwise live. */
export async function submitGrades(store: Store, grade: LLM, personaName: string): Promise<{ submitted: number; gradedLive: number }> {
  const todo = store.listResponses({ ungraded: true }).filter((r) => r.gradeBatchId === null && r.spotCheckAnswer);
  if (todo.length === 0) return { submitted: 0, gradedLive: 0 };
  const request = (r: (typeof todo)[number]) => ({
    ...buildGradePrompt(r.probe.question, r.probe.difficulty, r.spotCheckAnswer!, personaName),
    schema: GradeSchema,
    purpose: "grade",
  });
  if (batchable(grade) && supportsBatch(grade)) {
    const batchId = await grade.submitBatch(todo.map((r) => ({ id: r.id, req: request(r) })));
    store.setGradeBatch(todo.map((r) => r.id), batchId);
    return { submitted: todo.length, gradedLive: 0 };
  }
  for (const r of todo) {
    const g = await grade.generateObject(request(r));
    store.recordGrade(r.id, g.grade, g.reason);
  }
  return { submitted: 0, gradedLive: todo.length };
}

import type { ObservationInput } from "@standin/schema";
import type { Answer } from "./parse.ts";

/**
 * One observation per answer. The question is included for context; the
 * extraction prompt treats only the text after "A:" as the person's words.
 */
export function answerToObservation(a: Answer, opts: { bankId: string | null; occurredAt: string }): ObservationInput {
  const bank = opts.bankId ?? "adhoc";
  const question = a.question?.text ?? (a.writtenQuestion || a.questionId);
  return {
    sourceKind: "interview",
    sourceRef: `interview:${bank}#${a.questionId}`,
    authorRole: "self",
    occurredAt: opts.occurredAt,
    text: `Q: ${question}\n\nA: ${a.answer}`,
    meta: { bank, questionId: a.questionId, feeds: a.question?.feeds ?? [] },
  };
}

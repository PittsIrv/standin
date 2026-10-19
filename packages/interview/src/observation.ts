import type { ObservationInput } from "@standin/schema";
import type { QuestionBank } from "./bank.ts";
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

const NAME_MAX = 60;

/**
 * Observations for a parsed sheet: one per plain answer, and one per repeated item
 * (all its answers together, so extraction sees the whole project, skill or course).
 */
export function answersToObservations(
  answers: Answer[],
  bank: QuestionBank | null,
  opts: { bankId: string | null; occurredAt: string },
): { key: string; input: ObservationInput }[] {
  // Group in sheet order: a plain answer is its own group; a repeated item gathers all its answers.
  const groups = new Map<string, Answer[]>();
  for (const a of answers) {
    const key = a.item ? `${a.item.section}.${a.item.index}` : a.questionId;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups].map(([key, group]) => ({
    key,
    input: group[0]!.item ? itemObservation(key, group, bank, opts) : answerToObservation(group[0]!, opts),
  }));
}

function itemObservation(key: string, answers: Answer[], bank: QuestionBank | null, opts: { bankId: string | null; occurredAt: string }): ObservationInput {
  const bankId = opts.bankId ?? "adhoc";
  const { section, index } = answers[0]!.item!;
  const sectionDef = bank?.sections.find((s) => s.id === section);
  const named = answers.find((a) => a.question !== null && a.question.id === sectionDef?.questions[0]?.id);
  const name = named ? named.answer.split("\n")[0]!.trim().slice(0, NAME_MAX) : null;
  const pairs = answers.map((a) => `Q: ${a.question?.text ?? (a.writtenQuestion || a.questionId)}\nA: ${a.answer}`);
  return {
    sourceKind: "interview",
    sourceRef: `interview:${bankId}#${key}`,
    authorRole: "self",
    occurredAt: opts.occurredAt,
    text: `${sectionDef?.repeat?.label ?? section} ${index}${name ? ` (${name})` : ""}:\n\n${pairs.join("\n\n")}`,
    meta: { bank: bankId, item: key, questionIds: answers.map((a) => a.questionId) },
  };
}

import type { Lang, ObservationInput } from "@standin/schema";
import { detectLang } from "./lang.ts";
import type { Answer } from "./parse.ts";

/** The question in the language of the answer; both languages when the answer mixes them. */
function questionText(a: Answer, lang: Lang): string {
  if (!a.question) return a.writtenQuestion || a.questionId;
  if (lang === "zh") return a.question.zh;
  if (lang === "en") return a.question.en;
  return `${a.question.en} / ${a.question.zh}`;
}

/**
 * One observation per answer. The question is included for context; the
 * extraction prompt treats only the text after "A:" as the person's words.
 */
export function answerToObservation(
  a: Answer,
  opts: { bankId: string | null; occurredAt: string; lang?: Lang },
): ObservationInput {
  const lang = opts.lang ?? detectLang(a.answer);
  const bank = opts.bankId ?? "adhoc";
  return {
    sourceKind: "interview",
    sourceRef: `interview:${bank}#${a.questionId}`,
    authorRole: "self",
    lang,
    occurredAt: opts.occurredAt,
    text: `Q: ${questionText(a, lang)}\n\nA: ${a.answer}`,
    meta: { bank, questionId: a.questionId, feeds: a.question?.feeds ?? [] },
  };
}

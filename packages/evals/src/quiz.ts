import type { QuizAnswer } from "@standin/schema";

/** Rated answers needed before the agreement score is shown (answering spec §7). */
export const QUIZ_MIN_RATED = 20;

/** Self-quiz agreement: (same + ½·partly) / rated; null until enough answers are rated. */
export function agreement(answers: QuizAnswer[], min = QUIZ_MIN_RATED): { rated: number; score: number | null } {
  const rated = answers.filter((a) => a.rating !== null);
  const points = rated.reduce((n, a) => n + (a.rating === "same" ? 1 : a.rating === "partly" ? 0.5 : 0), 0);
  return { rated: rated.length, score: rated.length >= min ? points / rated.length : null };
}

import type { QuizAnswer, QuizRating } from "@standin/schema";
import { answerTurn, type Reply, type TurnDeps } from "@standin/speak";
import type { Store } from "@standin/store";
import { readCases, type EvalCase } from "./cases.ts";

/** Rated answers needed before the agreement score is shown (answering spec §7). */
export const QUIZ_MIN_RATED = 20;

/** Self-quiz agreement: (same + ½·partly) / rated; null until enough answers are rated. */
export function agreement(answers: QuizAnswer[], min = QUIZ_MIN_RATED): { rated: number; score: number | null } {
  const rated = answers.filter((a) => a.rating !== null);
  const points = rated.reduce((n, a) => n + (a.rating === "same" ? 1 : a.rating === "partly" ? 0.5 : 0), 0);
  return { rated: rated.length, score: rated.length >= min ? points / rated.length : null };
}

export interface QuizCard {
  caseId: string;
  question: string;
}

export interface QuizDeckDeps {
  store: Store;
  /** The person's private case file: quiz questions come from its known and not-on-record cases. */
  casesPath: string;
  turn: TurnDeps;
  /** A quiz comes as every n-th card. */
  every: number;
}

/**
 * The self-quiz (answering spec §7): a visitor-style question the person answers first, then sees the standin's reply
 * to and rates. Each case is quizzed once; "Skip" passes it for this session; the card on screen stays until answered.
 */
export class QuizDeck {
  private readonly skipped = new Set<string>();
  private shown: QuizCard | null = null;

  constructor(private readonly deps: QuizDeckDeps) {}

  private pool(): EvalCase[] {
    const quizzed = new Set(this.deps.store.listQuizAnswers().map((a) => a.caseId));
    return readCases(this.deps.casesPath).cases.filter((c) => (c.suite === "known" || c.suite === "not-on-record") && !quizzed.has(c.id) && !this.skipped.has(c.id));
  }

  /** A quiz card when one is due after `answeredSince` other cards, or the one already on screen. */
  due(answeredSince: number): QuizCard | null {
    if (this.shown) return this.shown;
    return answeredSince >= this.deps.every - 1 ? this.any() : null;
  }

  /** The next quiz card, if any is left. */
  any(): QuizCard | null {
    if (this.shown) return this.shown;
    const next = this.pool()[0];
    this.shown = next ? { caseId: next.id, question: next.question } : null;
    return this.shown;
  }

  /** Stores the person's answer next to a fresh reply from the standin; the person rates it next. */
  async answer(caseId: string, personAnswer: string, sessionId: string | null): Promise<{ quizId: string; reply: Reply }> {
    const c = readCases(this.deps.casesPath).cases.find((x) => x.id === caseId);
    if (!c) throw new Error(`no quiz case ${caseId}`);
    const reply = await answerTurn(this.deps.turn, c.question);
    const q = this.deps.store.addQuizAnswer({ caseId, question: c.question, personAnswer, standinReply: reply.text, state: reply.state, sessionId });
    if (this.shown?.caseId === caseId) this.shown = null;
    return { quizId: q.id, reply };
  }

  /** "Wrong" also keeps a preference pair, and the person's answer goes to compaction as a reviewable correction. */
  rate(quizId: string, rating: QuizRating): void {
    const { store } = this.deps;
    const q = store.rateQuizAnswer(quizId, rating);
    if (rating !== "wrong") return;
    store.addPreferencePair({ question: q.question, standinAnswer: q.standinReply, personAnswer: q.personAnswer });
    store.addObservation({ sourceKind: "answer", sourceRef: `quiz:${q.caseId}`, authorRole: "self", text: q.personAnswer, occurredAt: store.nowIso() });
  }

  skip(caseId: string): void {
    this.skipped.add(caseId);
    if (this.shown?.caseId === caseId) this.shown = null;
  }

  agreement(): { rated: number; score: number | null } {
    return agreement(this.deps.store.listQuizAnswers());
  }
}

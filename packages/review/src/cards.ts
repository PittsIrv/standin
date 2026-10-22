import { reviewQueue, type QueueGroup, type ReviewItem } from "@standin/compaction";
import type { QuizCard, QuizDeck } from "@standin/evals";
import type { CardSession, ClaimDecision, ShownCard, ShownQuestion } from "@standin/knowledge";
import type { Config, MemoryKind } from "@standin/schema";
import type { SourceSummary, Store } from "@standin/store";

/** A review-queue item as the page shows it. */
export interface QueueCard {
  id: string;
  /** A "Still true?" check on an approved current-state memory, rather than a proposal. */
  stillTrue: boolean;
  group: QueueGroup;
  memoryKind: MemoryKind;
  statement: string;
  tier: number;
  reasons: string[];
  sources: SourceSummary;
  /** The statement this one would replace, or conflicts with. */
  replaces: string | null;
  conflictsWith: string | null;
}

export type Card =
  | { type: "intro" }
  | { type: "card"; card: ShownCard }
  | { type: "keep-lower"; decision: ClaimDecision }
  | { type: "question"; question: ShownQuestion }
  | { type: "quiz"; quiz: QuizCard }
  | { type: "proposal"; item: QueueCard }
  | { type: "done" };

export function queueCard(store: Store, i: ReviewItem): QueueCard {
  const m = i.memory;
  return {
    id: m.id,
    stillTrue: i.kind === "still-true",
    group: i.group,
    memoryKind: m.kind,
    statement: m.statement,
    tier: m.tier,
    reasons: m.kind === "competence" ? (m.attrs.reasons ?? []) : [],
    sources: i.sources,
    replaces: m.supersedesId ? store.getMemory(m.supersedesId).statement : null,
    conflictsWith: m.conflictsWithId ? store.getMemory(m.conflictsWithId).statement : null,
  };
}

/**
 * The one card to show now, first match wins (concept-cards spec §4, §6a; questions spec §2; answering spec §7): the
 * card on screen (so a reload shows it again), the introduction, a keep-or-lower decision, a question when one is due
 * (every 5th card), a self-quiz when one is due (every 10th), the next concept card, any open question once those run
 * out, then any quiz, the review queue, then done.
 */
export async function nextCard(session: CardSession, store: Store, config: Config, quiz?: QuizDeck): Promise<Card> {
  const current = session.current();
  if (current) return { type: "card", card: current };
  if (session.needsIntro()) return { type: "intro" };
  const decision = session.keepLowerDue();
  if (decision) return { type: "keep-lower", decision };
  const due = session.questionDue();
  if (due) return { type: "question", question: due };
  const showQuiz = (q: QuizCard | null | undefined): Card | null => {
    if (!q) return null;
    session.quizShown();
    return { type: "quiz", quiz: q };
  };
  const quizDue = showQuiz(quiz?.due(session.answeredSinceQuiz()));
  if (quizDue) return quizDue;
  const card = await session.next();
  if (card) return { type: "card", card };
  const question = session.anyQuestion();
  if (question) return { type: "question", question };
  const anyQuiz = showQuiz(quiz?.any());
  if (anyQuiz) return anyQuiz;
  const item = reviewQueue(store, config)[0];
  if (item) return { type: "proposal", item: queueCard(store, item) };
  return { type: "done" };
}

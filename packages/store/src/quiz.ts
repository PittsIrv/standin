import { newId, PreferencePair, QuizAnswer, type QuizRating } from "@standin/schema";
import { NotFoundError } from "./errors.ts";
import type { Row } from "./rows.ts";
import type { Store } from "./store.ts";

const rowToQuiz = (r: Row): QuizAnswer =>
  QuizAnswer.parse({
    id: r.id,
    caseId: r.case_id,
    question: r.question,
    personAnswer: r.person_answer,
    standinReply: r.standin_reply,
    state: r.state,
    rating: r.rating ?? null,
    sessionId: r.session_id ?? null,
    at: r.at,
  });

export type NewQuizAnswer = Omit<QuizAnswer, "id" | "at" | "rating">;

export function addQuizAnswer(s: Store, q: NewQuizAnswer): QuizAnswer {
  const id = newId("qz");
  s.db
    .prepare("INSERT INTO quiz_answers (id, case_id, question, person_answer, standin_reply, state, session_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, q.caseId, q.question, q.personAnswer, q.standinReply, q.state, q.sessionId, s.nowIso());
  return getQuizAnswer(s, id);
}

export function getQuizAnswer(s: Store, id: string): QuizAnswer {
  const r = s.db.prepare("SELECT * FROM quiz_answers WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("quiz answer", id);
  return rowToQuiz(r);
}

export function rateQuizAnswer(s: Store, id: string, rating: QuizRating): QuizAnswer {
  getQuizAnswer(s, id);
  s.db.prepare("UPDATE quiz_answers SET rating = ? WHERE id = ?").run(rating, id);
  return getQuizAnswer(s, id);
}

/** Every quiz answer, oldest first. */
export function listQuizAnswers(s: Store): QuizAnswer[] {
  return (s.db.prepare("SELECT * FROM quiz_answers ORDER BY at, rowid").all() as Row[]).map(rowToQuiz);
}

export function addPreferencePair(s: Store, p: { question: string; standinAnswer: string; personAnswer: string }): PreferencePair {
  const id = newId("pp");
  s.db.prepare("INSERT INTO preference_pairs (id, question, standin_answer, person_answer, created_at) VALUES (?, ?, ?, ?, ?)").run(id, p.question, p.standinAnswer, p.personAnswer, s.nowIso());
  return listPreferencePairs(s).find((x) => x.id === id)!;
}

export function listPreferencePairs(s: Store): PreferencePair[] {
  return (s.db.prepare("SELECT * FROM preference_pairs ORDER BY created_at, rowid").all() as Row[]).map((r) =>
    PreferencePair.parse({ id: r.id, question: r.question, standinAnswer: r.standin_answer, personAnswer: r.person_answer, createdAt: r.created_at }),
  );
}

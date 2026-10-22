import { newId, Question, type QuestionStatus } from "@standin/schema";
import { NotFoundError } from "./errors.ts";
import type { Row } from "./rows.ts";
import type { Store } from "./store.ts";

const rowToQuestion = (r: Row): Question =>
  Question.parse({ id: r.id, nodeId: r.node_id, text: r.text, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at ?? null });

export function addQuestion(s: Store, q: { nodeId: string; text: string }): Question {
  const id = newId("qst");
  s.db.prepare("INSERT INTO questions (id, node_id, text, status, created_at) VALUES (?, ?, ?, 'open', ?)").run(id, q.nodeId, q.text, s.nowIso());
  return getQuestion(s, id);
}

export function getQuestion(s: Store, id: string): Question {
  const r = s.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row | undefined;
  if (!r) throw new NotFoundError("question", id);
  return rowToQuestion(r);
}

/** Questions, oldest first, by status and node. */
export function listQuestions(s: Store, f: { status?: QuestionStatus; nodeId?: string } = {}): Question[] {
  const rows = s.db
    .prepare("SELECT * FROM questions WHERE (? IS NULL OR status = ?) AND (? IS NULL OR node_id = ?) ORDER BY created_at, rowid")
    .all(f.status ?? null, f.status ?? null, f.nodeId ?? null, f.nodeId ?? null) as Row[];
  return rows.map(rowToQuestion);
}

export function setQuestionStatus(s: Store, id: string, status: QuestionStatus): Question {
  getQuestion(s, id);
  s.db.prepare("UPDATE questions SET status = ?, decided_at = ? WHERE id = ?").run(status, status === "open" ? null : s.nowIso(), id);
  return getQuestion(s, id);
}

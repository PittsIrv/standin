import { allQuestions, type Question, type QuestionBank } from "./bank.ts";
import { BANK_MARKER } from "./template.ts";

export interface Answer {
  questionId: string;
  /** The bank's question, or null for `extra.*` and other ids the bank doesn't have. */
  question: Question | null;
  /** The question text written in the file (from its `>` lines), used when `question` is null. */
  writtenQuestion: string;
  answer: string;
}

export interface ParsedSheet {
  bankId: string | null;
  answers: Answer[];
  /** Ids present in the file with a blank answer. */
  skipped: string[];
}

export class AnswerSheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerSheetError";
  }
}

const ID_HEADING = /^###\s+([a-z0-9][\w.-]*)\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;

function stripMarkup(line: string): string {
  return line
    .replace(/^>\s?/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/^_(.*)_$/, "$1")
    .trim();
}

/**
 * Reads a filled-in answer sheet. Only text under `### <id>` headings counts;
 * `>` lines (questions and hints) and HTML comments are ignored.
 */
export function parseAnswerSheet(markdown: string, banks: Record<string, QuestionBank>): ParsedSheet {
  const bankId = BANK_MARKER.exec(markdown)?.[1] ?? null;
  const bank = bankId ? banks[bankId] : undefined;
  if (bankId && !bank) throw new AnswerSheetError(`unknown question bank "${bankId}"`);
  const byId = new Map((bank ? allQuestions(bank) : []).map((q) => [q.id, q]));

  const lines = markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  const sections: { id: string; quoted: string[]; body: string[] }[] = [];
  let current: (typeof sections)[number] | null = null;
  for (const line of lines) {
    const id = ID_HEADING.exec(line)?.[1];
    if (id) {
      if (sections.some((s) => s.id === id)) throw new AnswerSheetError(`question "${id}" appears twice`);
      current = { id, quoted: [], body: [] };
      sections.push(current);
    } else if (ANY_HEADING.test(line)) {
      current = null;
    } else if (current) {
      if (/^\s*>/.test(line)) current.quoted.push(stripMarkup(line.trim()));
      else current.body.push(line);
    }
  }

  const answers: Answer[] = [];
  const skipped: string[] = [];
  for (const s of sections) {
    const answer = s.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!answer) {
      skipped.push(s.id);
      continue;
    }
    const question = byId.get(s.id) ?? null;
    const written = s.quoted.filter(Boolean)[0] ?? "";
    answers.push({ questionId: s.id, question, writtenQuestion: written, answer });
  }
  return { bankId, answers, skipped };
}

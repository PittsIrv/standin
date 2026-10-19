import { allQuestions, type Question, type QuestionBank } from "./bank.ts";
import { BANK_MARKER, REPEAT_MARKER } from "./template.ts";

export interface Answer {
  questionId: string;
  /** The bank's question, or null for `extra.*` and other ids the bank doesn't have. */
  question: Question | null;
  /** The question text written in the file (from its `>` lines), used when `question` is null. */
  writtenQuestion: string;
  answer: string;
  /** Set for answers inside a repeating block: which section and which copy (1-based). */
  item: { section: string; index: number } | null;
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

  // Repeat markers survive as sentinel lines; every other comment is dropped.
  const SENTINEL = "\u0000repeat:";
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => {
      const section = REPEAT_MARKER.exec(line.trim())?.[1];
      return section ? `${SENTINEL}${section}` : line;
    })
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n");
  const sections: { id: string; baseId: string; item: Answer["item"]; quoted: string[]; body: string[] }[] = [];
  const copies = new Map<string, number>();
  let block: { section: string; index: number } | null = null;
  let current: (typeof sections)[number] | null = null;
  for (const line of lines) {
    if (line.startsWith(SENTINEL)) {
      const section = line.slice(SENTINEL.length);
      const index = (copies.get(section) ?? 0) + 1;
      copies.set(section, index);
      block = { section, index };
      current = null;
      continue;
    }
    const baseId = ID_HEADING.exec(line)?.[1];
    if (baseId) {
      const inBlock = block !== null && baseId.startsWith(`${block.section}.`);
      const id = inBlock ? `${block!.section}.${block!.index}.${baseId.slice(block!.section.length + 1)}` : baseId;
      if (sections.some((s) => s.id === id)) throw new AnswerSheetError(`question "${id}" appears twice`);
      current = { id, baseId, item: inBlock ? { ...block! } : null, quoted: [], body: [] };
      sections.push(current);
    } else if (ANY_HEADING.test(line)) {
      current = null;
      block = null;
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
    const question = byId.get(s.baseId) ?? null;
    const written = s.quoted.filter(Boolean)[0] ?? "";
    answers.push({ questionId: s.id, question, writtenQuestion: written, answer, item: s.item });
  }
  return { bankId, answers, skipped };
}

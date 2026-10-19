import { describe, expect, it } from "vitest";
import {
  answersToObservations,
  answerToObservation,
  AnswerSheetError,
  BANKS as BANKS_ALL,
  CORE_V1,
  parseAnswerSheet,
  renderTemplate,
  type QuestionBank,
} from "../src/index.ts";

const BANK: QuestionBank = {
  id: "test-v1",
  sections: [
    {
      id: "projects",
      title: "Projects",
      repeat: { label: "Project", copies: 3 },
      questions: [
        { id: "projects.name", text: "What's the project called?", feeds: ["fact"] },
        { id: "projects.role", text: "What was your role?", feeds: ["fact"] },
      ],
    },
    { id: "next", title: "Next", questions: [{ id: "next.build", text: "What next?", feeds: ["current"] }] },
  ],
};
const BANKS = { [BANK.id]: BANK };

/** Fills the `copy`-th occurrence (1-based) of a heading. */
function fillCopy(sheet: string, heading: string, copy: number, answer: string): string {
  let seen = 0;
  return sheet.replace(new RegExp(`(### ${heading.replace(/\./g, "\\.")}\\n(?:>.*\\n)+)`, "g"), (m) => (++seen === copy ? `${m}\n${answer}\n` : m));
}

describe("repeating blocks", () => {
  it("renders each repeating section as marked copies, with instructions", () => {
    const sheet = renderTemplate(BANK);
    expect(sheet.match(/<!-- repeat: projects -->/g)).toHaveLength(3);
    expect(sheet.match(/### projects\.role/g)).toHaveLength(3);
    expect(sheet).toContain("copy a whole block, including its `<!-- repeat -->` line");
  });

  it("numbers copies by their markers and links answers to the bank's question", () => {
    let sheet = renderTemplate(BANK);
    sheet = fillCopy(sheet, "projects.name", 1, "Kite, a Go-variant engine.");
    sheet = fillCopy(sheet, "projects.role", 3, "Solo.");
    sheet = fillCopy(sheet, "next.build", 1, "A poker trainer.");
    const parsed = parseAnswerSheet(sheet, BANKS);
    expect(parsed.answers.map((a) => [a.questionId, a.item])).toEqual([
      ["projects.1.name", { section: "projects", index: 1 }],
      ["projects.3.role", { section: "projects", index: 3 }],
      ["next.build", null],
    ]);
    expect(parsed.answers[0]!.question?.id).toBe("projects.name");
  });

  it("numbers by the markers actually present, and blank copies produce nothing", () => {
    const sheet = renderTemplate(BANK);
    const blocks = sheet.split("<!-- repeat: projects -->");
    const lastOnly = [blocks[0], blocks[3]].join("<!-- repeat: projects -->");
    const parsed = parseAnswerSheet(fillCopy(lastOnly, "projects.name", 1, "Kite."), BANKS);
    expect(parsed.answers.map((a) => a.questionId)).toEqual(["projects.1.name"]);
    expect(parseAnswerSheet(sheet, BANKS).answers).toEqual([]);
  });

  it("rejects a copied block that lost its marker (a heading repeats within one item)", () => {
    const md = [
      "<!-- standin interview · bank: test-v1 -->",
      "<!-- repeat: projects -->",
      "### projects.role",
      "Lead.",
      "### projects.role",
      "Solo.",
    ].join("\n");
    expect(() => parseAnswerSheet(md, BANKS)).toThrow(AnswerSheetError);
    expect(() => parseAnswerSheet(md, BANKS)).toThrow(/projects\.1\.role/);
  });
});

describe("answersToObservations", () => {
  const opts = { bankId: "test-v1", occurredAt: "2026-10-19T00:00:00.000Z" };

  it("makes one observation per item, named by its first answer", () => {
    let sheet = renderTemplate(BANK);
    sheet = fillCopy(sheet, "projects.name", 2, "Kite, a Go-variant engine.");
    sheet = fillCopy(sheet, "projects.role", 2, "Solo.");
    sheet = fillCopy(sheet, "next.build", 1, "A poker trainer.");
    const out = answersToObservations(parseAnswerSheet(sheet, BANKS).answers, BANK, opts);
    expect(out.map((o) => o.key)).toEqual(["projects.2", "next.build"]);
    expect(out[0]!.input).toEqual({
      sourceKind: "interview",
      sourceRef: "interview:test-v1#projects.2",
      authorRole: "self",
      occurredAt: opts.occurredAt,
      text: "Project 2 (Kite, a Go-variant engine.):\n\nQ: What's the project called?\nA: Kite, a Go-variant engine.\n\nQ: What was your role?\nA: Solo.",
      meta: { bank: "test-v1", item: "projects.2", questionIds: ["projects.2.name", "projects.2.role"] },
    });
    expect(out[1]!.input.text).toBe("Q: What next?\n\nA: A poker trainer.");
  });

  it("keeps two items with the same answer apart, and omits the name when it's blank", () => {
    let sheet = renderTemplate(BANK);
    sheet = fillCopy(sheet, "projects.role", 1, "Solo.");
    sheet = fillCopy(sheet, "projects.role", 2, "Solo.");
    const out = answersToObservations(parseAnswerSheet(sheet, BANKS).answers, BANK, opts);
    expect(out.map((o) => o.input.text)).toEqual(["Project 1:\n\nQ: What was your role?\nA: Solo.", "Project 2:\n\nQ: What was your role?\nA: Solo."]);
  });

  it("leaves sheets without repeating blocks exactly as before", () => {
    const sheet = fillCopy(renderTemplate(CORE_V1), "now.work", 1, "I'm building standin.");
    const answers = parseAnswerSheet(sheet, BANKS_ALL).answers;
    expect(answersToObservations(answers, CORE_V1, { bankId: "core-v1", occurredAt: opts.occurredAt }).map((o) => o.input)).toEqual(
      answers.map((a) => answerToObservation(a, { bankId: "core-v1", occurredAt: opts.occurredAt })),
    );
  });
});

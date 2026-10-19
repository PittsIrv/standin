import { ObservationInput } from "@standin/schema";
import { describe, expect, it } from "vitest";
import {
  allQuestions,
  answerToObservation,
  AnswerSheetError,
  BANKS,
  CORE_V1,
  parseAnswerSheet,
  renderTemplate,
} from "../src/index.ts";

/** Writes `answer` under the heading for `id` in a rendered sheet. */
function fill(sheet: string, answers: Record<string, string>): string {
  let out = sheet;
  for (const [id, answer] of Object.entries(answers)) {
    const re = new RegExp(`(### ${id.replace(/\./g, "\\.")}\\n(?:>.*\\n)+)`);
    expect(re.test(out), id).toBe(true);
    out = out.replace(re, `$1\n${answer}\n`);
  }
  return out;
}

describe("question bank", () => {
  it("has unique ids, English text only, and section-prefixed ids", () => {
    const qs = allQuestions(CORE_V1);
    expect(qs.length).toBeGreaterThanOrEqual(30);
    expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
    for (const s of CORE_V1.sections)
      for (const q of s.questions) {
        expect(q.id.startsWith(`${s.id}.`)).toBe(true);
        expect(q.text.trim()).not.toBe("");
        expect("zh" in q).toBe(false);
        expect(q.feeds.length).toBeGreaterThan(0);
      }
  });

  it("asks about what the person doesn't know", () => {
    expect(allQuestions(CORE_V1).filter((q) => q.feeds.includes("negative")).length).toBeGreaterThanOrEqual(2);
  });
});

describe("answer sheets", () => {
  it("round-trips a rendered template: answered questions only, hints ignored", () => {
    const sheet = fill(renderTemplate(CORE_V1), {
      "basics.intro": "Hi, I'm a grad student who builds game AIs.",
      "competence.gaps": "> quoted hint-like line is dropped\nI don't really get compiler optimization.",
    });
    const parsed = parseAnswerSheet(sheet, BANKS);
    expect(parsed.bankId).toBe("core-v1");
    expect(parsed.answers.map((a) => [a.questionId, a.answer])).toEqual([
      ["basics.intro", "Hi, I'm a grad student who builds game AIs."],
      ["competence.gaps", "I don't really get compiler optimization."],
    ]);
    expect(parsed.skipped).toHaveLength(allQuestions(CORE_V1).length - 2);
    expect(parsed.answers[0]!.question?.text).toContain("introduce yourself");
    expect(sheet).not.toMatch(/\p{Script=Han}/u);
    expect(sheet).not.toContain("Mix languages");
  });

  it("an empty template has no answers", () => {
    expect(parseAnswerSheet(renderTemplate(CORE_V1), BANKS).answers).toEqual([]);
  });

  it("keeps extra sections and multi-paragraph answers, ignores comments", () => {
    const md = [
      "<!-- standin interview · bank: core-v1 -->",
      "intro text outside any section",
      "### now.work",
      "First paragraph.",
      "",
      "<!-- private note -->",
      "Second paragraph.",
      "## next section",
      "stray text",
      "### extra.poker",
      "> **How did you get into poker?**",
      "Home games in college.",
    ].join("\n");
    const parsed = parseAnswerSheet(md, BANKS);
    expect(parsed.answers.map((a) => a.answer)).toEqual(["First paragraph.\n\nSecond paragraph.", "Home games in college."]);
    const extra = parsed.answers[1]!;
    expect(extra.question).toBeNull();
    expect(extra.writtenQuestion).toBe("How did you get into poker?");
  });

  it("rejects duplicated ids and unknown banks", () => {
    expect(() => parseAnswerSheet("### a.b\nx\n### a.b\ny", BANKS)).toThrow(AnswerSheetError);
    expect(() => parseAnswerSheet("<!-- standin interview · bank: nope -->", BANKS)).toThrow(/unknown question bank/);
  });
});

describe("answerToObservation", () => {
  const sheet = fill(renderTemplate(CORE_V1), {
    "now.work": "I'm building standin.",
    "now.learning": "DPO and preference tuning.",
  });
  const answers = parseAnswerSheet(sheet, BANKS).answers;
  const obs = (id: string) =>
    answerToObservation(answers.find((a) => a.questionId === id)!, { bankId: "core-v1", occurredAt: "2026-10-02T00:00:00.000Z" });

  it("produces a valid self-authored interview observation", () => {
    const o = obs("now.work");
    expect(ObservationInput.parse(o)).toMatchObject({
      sourceKind: "interview",
      authorRole: "self",
      sourceRef: "interview:core-v1#now.work",
      meta: { bank: "core-v1", questionId: "now.work" },
    });
    expect(o.text).toBe("Q: What are you working on right now, and why that?\n\nA: I'm building standin.");
  });

  it("writes the English question before the answer", () => {
    expect(obs("now.learning").text).toMatch(/^Q: What are you learning[^\n]*\n\nA: DPO and preference tuning\.$/);
    expect("lang" in obs("now.learning")).toBe(false);
  });
});

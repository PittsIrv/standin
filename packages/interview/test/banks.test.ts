import { describe, expect, it } from "vitest";
import { allQuestions, BANKS, parseAnswerSheet, renderTemplate } from "../src/index.ts";

const IDS = ["core-v1", "projects-v1", "skills-v1", "education-v1", "opinions-v1", "life-v1"];

describe("detailed banks", () => {
  it("registers the core interview and the five detailed banks", () => {
    expect(Object.keys(BANKS).sort()).toEqual([...IDS].sort());
  });

  it("has unique, section-prefixed ids, feeds on every question, and 3 copies per repeating section", () => {
    for (const bank of Object.values(BANKS)) {
      const qs = allQuestions(bank);
      expect(new Set(qs.map((q) => q.id)).size, bank.id).toBe(qs.length);
      for (const s of bank.sections) {
        for (const q of s.questions) {
          expect(q.id.startsWith(`${s.id}.`), q.id).toBe(true);
          expect(q.feeds.length, q.id).toBeGreaterThan(0);
        }
        if (s.repeat) expect(s.repeat, s.id).toMatchObject({ copies: 3, label: expect.any(String) });
      }
    }
  });

  it("uses the approved wording", () => {
    const q = (bank: string, id: string) => allQuestions(BANKS[bank]!).find((x) => x.id === id)!;
    expect(q("skills-v1", "skills.depth")).toMatchObject({
      text: "How deep, 0–4?",
      hint: "0 don't know · 1 aware of it · 2 working knowledge · 3 strong · 4 expert",
    });
    expect(q("projects-v1", "projects.role")).toMatchObject({
      text: "What was your role, and who else was involved?",
      hint: "Roles are enough; don't name private individuals.",
    });
    expect(q("opinions-v1", "opinions.strength").text).toBe("How strongly (1–5), and what would change your mind?");
    expect(q("life-v1", "share.fact").text).toBe("A fun fact about you that you're happy to share.");
    expect(BANKS["education-v1"]!.sections.find((s) => s.id === "courses")!.repeat!.label).toBe("Course");
  });

  it("renders every bank as a sheet that parses back with no answers", () => {
    for (const bank of Object.values(BANKS)) expect(parseAnswerSheet(renderTemplate(bank), BANKS).answers, bank.id).toEqual([]);
  });
});

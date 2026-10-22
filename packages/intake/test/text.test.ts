import { describe, expect, it } from "vitest";
import { align, sections, unwrap } from "../src/index.ts";

describe("align", () => {
  const source = "EXPERIENCE\nResearch intern, Robotics Lab (2022–2024): built a motion-\nplanning stack for “legged” robots.";
  it("finds a quote that only differs in case, spacing, hyphenation and typography", () => {
    expect(align('built a motion-planning stack for "legged" robots', source)).toBe("exact");
    expect(align("Research Intern,  robotics lab (2022-2024)", source)).toBe("exact");
  });
  it("accepts a near-exact quote and refuses a paraphrase", () => {
    expect(align("Robotics Lab 2022-2024 built a motion planning stack for leged robots", source)).toBe("fuzzy");
    expect(align("designed control software for quadrupeds", source)).toBeNull();
    expect(align("", source)).toBeNull();
  });
});

describe("sections", () => {
  it("splits on headings and title-like lines", () => {
    const s = sections("# Lin Qiao\nGame AI builder.\n\nEDUCATION\nMS in CS, 2025.\n\nExperience\nIntern at Kite Labs.");
    expect(s.map((x) => x.heading)).toEqual(["Lin Qiao", "EDUCATION", "Experience"]);
    expect(s[1]!.text).toContain("MS in CS");
  });
  it("chunks long text with overlap", () => {
    const long = Array.from({ length: 900 }, (_, i) => `Sentence number ${i}.`).join(" ");
    const s = sections(long);
    expect(s.length).toBeGreaterThan(3);
    for (const x of s) expect(x.text.length).toBeLessThanOrEqual(4000);
    expect(s[1]!.text.slice(0, 50)).toBe(long.slice(s[0]!.text.length - 200, s[0]!.text.length - 150));
  });
});

describe("unwrap", () => {
  it("joins a line broken mid-sentence, as PDFs break them, and keeps real line breaks", () => {
    const pdf = [
      "Languages: Python, C, SQL — Frameworks: React, Next.js, NestJS,",
      "Django, Flask, Docker",
      "• Assisted students via 1:1 tutor sessions on proofs and theory topics; designed study",
      "guides and exam reviews.",
      "• Built tools to analyze bias in",
      "AI-generated images.",
      "Research Assistant May 2024 – Present",
      "Chimps Lab, CMU",
      "I work on motion-",
      "planning.",
    ].join("\n");
    expect(unwrap(pdf).split("\n")).toEqual([
      "Languages: Python, C, SQL — Frameworks: React, Next.js, NestJS, Django, Flask, Docker",
      "• Assisted students via 1:1 tutor sessions on proofs and theory topics; designed study guides and exam reviews.",
      "• Built tools to analyze bias in AI-generated images.",
      "Research Assistant May 2024 – Present",
      "Chimps Lab, CMU",
      "I work on motion-planning.",
    ]);
  });
  it("leaves paragraphs, list items and short lines alone", () => {
    const text = "I study CS.\n\n- reading\n- climbing\nEDUCATION\nBS in Math";
    expect(unwrap(text)).toBe(text);
  });
});

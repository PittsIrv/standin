import { describe, expect, it } from "vitest";
import { align, sections, stripContacts } from "../src/index.ts";

describe("stripContacts", () => {
  it("removes emails, phone numbers and street addresses, and counts them", () => {
    const r = stripContacts("Mail me at lin.q@example.edu or call +1 (412) 555-0199.\nI live at 5000 Forbes Avenue, Pittsburgh.\nI started in 2019 and wrote 3 papers.");
    expect(r.text).toBe("Mail me at [removed] or call [removed].\nI live at [removed], Pittsburgh.\nI started in 2019 and wrote 3 papers.");
    expect(r.removed).toBe(3);
  });
});

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

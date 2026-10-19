import type { QuestionBank } from "./bank.ts";

export const BANK_MARKER = /<!--\s*standin interview\s*·\s*bank:\s*([\w.-]+)/;

/** Starts one copy of a repeating block. */
export const REPEAT_MARKER = /^<!--\s*repeat:\s*([\w-]+)\s*-->\s*$/;
export const repeatMarker = (sectionId: string) => `<!-- repeat: ${sectionId} -->`;

const INTRO = [
  "Write under each question the way you'd actually talk.",
  "Leave an answer blank to skip it. Lines starting with `>` are questions and hints; they are not imported.",
  "To add your own topic, write a `### extra.<name>` heading, a `>` line with the question, then your answer.",
  "This file is private: keep it inside your standin instance and never commit it.",
  "When you're done: `standin interview import <this file>`. Nothing is shared until you approve it in `standin queue`.",
];

const REPEAT_INTRO =
  "Some sections repeat once per item. To add another project (or skill, course…), copy a whole block, including its `<!-- repeat -->` line. Delete blocks you don't need, or leave them blank.";

/** Renders the Markdown answer sheet for a bank. Only `### <id>` sections are imported back. */
export function renderTemplate(bank: QuestionBank): string {
  const out: string[] = [
    `<!-- standin interview · bank: ${bank.id} · keep the "### id" headings as they are -->`,
    `# standin interview · ${bank.id}`,
    "",
    ...INTRO.map((s) => `- ${s}`),
    ...(bank.sections.some((s) => s.repeat) ? [REPEAT_INTRO].map((s) => `- ${s}`) : []),
    "",
  ];
  const questions = (section: QuestionBank["sections"][number]) => {
    for (const q of section.questions) {
      out.push(`### ${q.id}`, `> **${q.text}**`);
      if (q.hint) out.push(`> _${q.hint}_`);
      out.push("", "", "");
    }
  };
  for (const section of bank.sections) {
    out.push(`## ${section.title}`, "");
    if (!section.repeat) {
      questions(section);
      continue;
    }
    for (let i = 1; i <= section.repeat.copies; i++) {
      out.push(repeatMarker(section.id), `<!-- ${section.repeat.label} ${i} -->`, "");
      questions(section);
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

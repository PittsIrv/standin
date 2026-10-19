import type { QuestionBank } from "./bank.ts";

export const BANK_MARKER = /<!--\s*standin interview\s*·\s*bank:\s*([\w.-]+)/;

const INTRO = [
  "Write under each question the way you'd actually talk.",
  "Leave an answer blank to skip it. Lines starting with `>` are questions and hints; they are not imported.",
  "To add your own topic, write a `### extra.<name>` heading, a `>` line with the question, then your answer.",
  "This file is private: keep it inside your standin instance and never commit it.",
  "When you're done: `standin interview import <this file>`. Nothing is shared until you approve it in `standin queue`.",
];

/** Renders the Markdown answer sheet for a bank. Only `### <id>` sections are imported back. */
export function renderTemplate(bank: QuestionBank): string {
  const out: string[] = [
    `<!-- standin interview · bank: ${bank.id} · keep the "### id" headings as they are -->`,
    `# standin interview · ${bank.id}`,
    "",
    ...INTRO.map((s) => `- ${s}`),
    "",
  ];
  for (const section of bank.sections) {
    out.push(`## ${section.title}`, "");
    for (const q of section.questions) {
      out.push(`### ${q.id}`, `> **${q.text}**`);
      if (q.hint) out.push(`> _${q.hint}_`);
      out.push("", "", "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

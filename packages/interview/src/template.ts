import type { QuestionBank } from "./bank.ts";

export type TemplateLang = "both" | "en" | "zh";

export const BANK_MARKER = /<!--\s*standin interview\s*·\s*bank:\s*([\w.-]+)/;

const INTRO: Record<"en" | "zh", string[]> = {
  en: [
    "Write under each question the way you'd actually talk. Mix languages freely.",
    "Leave an answer blank to skip it. Lines starting with `>` are questions and hints; they are not imported.",
    "To add your own topic, write a `### extra.<name>` heading, a `>` line with the question, then your answer.",
    "This file is private: keep it inside your standin instance and never commit it.",
    "When you're done: `standin interview import <this file>`. Nothing is shared until you approve it in `standin queue`.",
  ],
  zh: [
    "在每个问题下面，用你平时说话的方式写。中英文可以随意混用。",
    "不想回答就留空。以 `>` 开头的行是问题和提示，不会被导入。",
    "想补充别的话题：写一个 `### extra.<名字>` 标题，一行 `>` 写问题，再写回答。",
    "这个文件是私密的：放在 standin 实例目录里，不要提交到任何仓库。",
    "写完后运行 `standin interview import <文件>`。在 `standin queue` 里批准之前，什么都不会公开。",
  ],
};

/** Renders the Markdown answer sheet for a bank. Only `### <id>` sections are imported back. */
export function renderTemplate(bank: QuestionBank, lang: TemplateLang = "both"): string {
  const langs: ("en" | "zh")[] = lang === "both" ? ["en", "zh"] : [lang];
  const out: string[] = [
    `<!-- standin interview · bank: ${bank.id} · keep the "### id" headings as they are -->`,
    `# standin interview · ${bank.id}`,
    "",
  ];
  for (const l of langs) out.push(...INTRO[l].map((s) => `- ${s}`), "");

  for (const section of bank.sections) {
    out.push(`## ${langs.map((l) => section.title[l]).join(" · ")}`, "");
    for (const q of section.questions) {
      out.push(`### ${q.id}`);
      for (const l of langs) out.push(`> **${q[l]}**`);
      if (q.hint) out.push(`> _${langs.map((l) => q.hint![l]).join(" · ")}_`);
      out.push("", "", "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

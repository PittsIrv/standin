import type { QuestionBank } from "../bank.ts";

/** One block per skill, with a self-rated depth that becomes an exact claim for the knowledge map. */
export const SKILLS_V1: QuestionBank = {
  id: "skills-v1",
  sections: [
    {
      id: "skills",
      title: "Skills",
      repeat: { label: "Skill", copies: 3 },
      questions: [
        { id: "skills.name", text: "Which skill, tool, or area?", feeds: ["competence"] },
        {
          id: "skills.depth",
          text: "How deep, 0–4?",
          feeds: ["competence"],
          hint: "0 don't know · 1 aware of it · 2 working knowledge · 3 strong · 4 expert",
        },
        { id: "skills.where", text: "Where have you used it? Name a project, course, or job.", feeds: ["fact", "competence"] },
        { id: "skills.cant", text: "What can't you do with it yet, or which parts haven't you touched?", feeds: ["negative"] },
      ],
    },
    { id: "learning", title: "Learning", questions: [{ id: "learning.now", text: "What are you learning right now?", feeds: ["current"] }] },
  ],
};
